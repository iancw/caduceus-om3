// XMP packet check in an om-emu E147 play session (our script; emulator only, not a camera).
//   OM_EMU_MODEL=E147 [OM_WORKER_ENTRY=60a8f623] node xmp_check.mjs EMU_DIR IMAGE CARD.omsd OUT.json ['tokens...']
// IMAGE = a decoded main block (stock: $OM3_MAIN; a build: out/main.bin). Boots to idle, runs the key tokens (as
// session_ed1.mjs: s1 half-press, ok/down/info/..., main+N / sub+N), then writes OUT.json with:
//   packet_hex     the 2301 bytes at 0x62a982e6 (the RAM XMP packet the JPEG writer copies)
//   writer         the stock JPEG XMP writer 0x60455cfa called directly into a scratch buffer: steps, bytes written
//                  (FF E1 + length + header + packet = 2334), and whether the packet it copied equals packet_hex
// Findings (2026-11-10, stock image, emulator only): the packet is NOT built during boot or a half-press (the buffer
// stays zero, the builder 0x60455f0e never runs), and the stock writer cannot be run directly: its first helper call
// (0x50002909, the ROM memcpy) faults ("trap reason=4 pc=0x50002909"): the 0x5000xxxx library is not in the emulator.
// So `writer.done` is false here; the script is the harness for the later checks (it reports honestly).
const [EMU, IMAGE, CARD, OUT, SCRIPT = ''] = process.argv.slice(2);
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const zlib = await import('node:zlib');
const { expandImage } = await import(EMU + '/src/fw/expand.mjs');
const { loadBlock } = await import(EMU + '/bin/run.mjs');
const { Player } = await import(EMU + '/src/lab/player.mjs');
const { PLAYER_PARSER } = await import(EMU + '/scenarios/session_replay.mjs');
const { cardFromImage } = await import(EMU + '/src/lab/sdcard.mjs');
const { PlaySession } = await import(EMU + '/src/lab/play.mjs');
const { Debugger } = await import(EMU + '/src/debug/debugger.mjs');
if (process.env.OM_WORKER_ENTRY) { const ca = await import(EMU + '/src/lab/camapp.mjs'); ca.CA_TASK_ENTRIES.push((parseInt(process.env.OM_WORKER_ENTRY, 16) - 0x10021020) >>> 0); }
const WORKER_ENTRY = process.env.OM_WORKER_ENTRY ? parseInt(process.env.OM_WORKER_ENTRY, 16) : 0;
const oldCreated = PlaySession.prototype.lab_created;
PlaySession.prototype.lab_created = function (lab) { oldCreated?.call(this, lab); if (WORKER_ENTRY) lab.lt.allow.add(WORKER_ENTRY - 0x10021020); };

const PACKET = 0x62a982e6, PACKET_LEN = 2301, WRITER = 0x60455cfa;
let c0 = cardFromImage(new Uint8Array(fs.readFileSync(CARD)));
const card = { open: () => c0, save: (x) => { c0 = x; } };
const rom = expandImage(new Uint8Array(fs.readFileSync(IMAGE)));
const env = { rom, resBlock: loadBlock(), createHash, card,
  deflate: (b, l) => new Uint8Array(zlib.deflateSync(b, { level: l })), inflate: (b) => new Uint8Array(zlib.inflateSync(b)) };
const pl = new Player({ ...PLAYER_PARSER, no_browser: true, idle: 'off', a15: 'on', out: '<out>', no_wait_on_error: true, device: 'tft' },
  { ...env, wallClock: () => performance.now() / 1000 });
pl.open_session();
const s = pl.session, lab = s.lab;
const rd = (a, n) => lab.sim.read(a >>> 0, n);
// XMP_TRACE=hexpc,hexpc,...: report how often each pc ran (from power-on on), e.g. 60455f0e = the packet builder
const TRACE = (process.env.XMP_TRACE || '').split(',').filter(Boolean).map((x) => parseInt(x, 16) >>> 0), hits = {};
if (TRACE.length) Debugger.attach(lab.sim, { lab }).traceExec((r) => { const k = r.pc.toString(16); hits[k] = (hits[k] || 0) + 1; if (process.env.XMP_TRACE_LOG) console.log('TR', k, 'd0', r.d0.toString(16), 'd1', r.d1.toString(16), 'd2', r.d2.toString(16)); }, { pcs: TRACE });
s.idle_slice(lab.lab_time() + 1500e6);
lab.sim.write(0xa32de590, new Uint8Array([0xff, 0x03, 0, 0])); lab.sim.write(0x60369308, new Uint8Array([0x00, 0xf0, 0, 0]));   // as session_ed1.mjs (the camera app's gates)
for (const t of SCRIPT.split(/\s+/).filter(Boolean)) {
  const m = /^(main|sub)([+-]\d+)$/.exec(t);
  if (m) { s.dial_input(m[1], parseInt(m[2], 10)); s.camapp.pump(); }
  else if (t !== 'wait') { s.key(t, 'down'); s.camapp.pump(); s.idle_slice(lab.lab_time() + 150e6); s.key(t, 'up'); s.camapp.pump(); }
  s.idle_slice(lab.lab_time() + 1200e6);
}

const hex = (b) => Buffer.from(b).toString('hex');
const packet = Buffer.from(rd(PACKET, PACKET_LEN));
const text = packet.toString('latin1');

/** Run the stock writer 0x60455cfa the way its caller does (`call WRITER,[d2],8` from a one-instruction stub), a1 = scratch. */
function callWriter() {
  const dd = Debugger.attach(lab.sim, {}), saved = dd.m.getRegs().slice();
  const sp = ((saved[8] - 0x800) & ~3) >>> 0, stub = (sp - 0x100) >>> 0, B = ((sp - 0x6000) & ~0xff) >>> 0, rel = (WRITER - stub) | 0;
  dd.write(B, new Uint8Array(2400).fill(0xee));
  dd.write(stub, Uint8Array.from([0xdd, rel & 255, rel >> 8 & 255, rel >> 16 & 255, rel >>> 24 & 255, 0x80, 0x08, 0xcb, 0xcb]));
  const r = saved.slice(); r[9] = stub; r[8] = sp; r[5] = B; r[4] = 0; dd.m.setRegs(r);
  const o = dd.cont({ stops: [stub + 7], budget: 5000000 });                   // `cont`, not single steps: the ROM helpers (memcpy ...) run natively
  const pc = dd.m.getRegs()[9] >>> 0, done = pc === stub + 7, ret = dd.m.getRegs()[0] >>> 0;
  const out = Buffer.from(rd(B, 2400));
  dd.breakpoints([]); dd.m.setRegs(saved);
  const end = out.indexOf(Buffer.alloc(16, 0xee));
  return { done, stop: o.stop, pc: pc.toString(16), d0: ret, written: end < 0 ? 2400 : end, head_hex: hex(out.subarray(0, 4 + 29)), packet_equal: out.subarray(33, 33 + PACKET_LEN).equals(packet) };
}

// ---- XMP_FMT_DIR=OUTDIR [XMP_GOLDEN=docs/xmp-golden.json]: run the code block's formatter xb_xfmt (xblock.s) on a hand-made
// stock-shaped packet for each golden case and compare (emulator only; the stock builder/writer cannot run here).
// Needs the build's GUIDES.BIN on the card (tools/emulator/card_add_file.py) and the token 's1' to load the block.
let fmt = null;
if (process.env.XMP_FMT_DIR) {
  const xj = JSON.parse(fs.readFileSync(process.env.XMP_FMT_DIR + '/xblock.json', 'utf8'));
  const golden = JSON.parse(fs.readFileSync(process.env.XMP_GOLDEN || new URL('../../docs/xmp-golden.json', import.meta.url), 'utf8'));
  const STATE = 0x62b4dd16, POOL = 0xa2852000, XPTR = 692;
  const u16 = (a) => { const b = rd(a, 2); return b[0] | b[1] << 8; }, u32 = (a) => { const b = rd(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
  const P = POOL + u16(STATE) - 1, base = u32(P + XPTR);
  fmt = { state: u16(STATE), P: P.toString(16), lptr: u32(P + 708).toString(16), gptr: u32(P + 700).toString(16), block_base: base.toString(16), xb_xfmt: xj.entries.xb_xfmt ?? null, cases: [], ok: false };
  if (base && xj.entries.xb_xfmt) {
    const dd = Debugger.attach(lab.sim, {});
    const fn = (base + parseInt(xj.entries.xb_xfmt, 16)) >>> 0;
    const stock = (rating = '0') => {
      const head = '<?xpacket begin="\u00ef\u00bb\u00bf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about=""\n   xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="' + rating + '"';
      const tail = '/>\n </rdf:RDF>\n</x:xmpmeta>\n', end = '<?xpacket end="w"?>';
      const b = Buffer.alloc(PACKET_LEN, 0x20); Buffer.from(head + tail, 'latin1').copy(b);
      for (let o = head.length + tail.length + 100; o < PACKET_LEN - end.length - 1; o += 101) b[o] = 10;
      Buffer.from(end, 'latin1').copy(b, PACKET_LEN - end.length); return b;
    };
    const call = (a0, a1, d0, d1) => {
      const saved = dd.m.getRegs().slice(), sp = ((saved[8] - 0x800) & ~3) >>> 0, stub = (sp - 0x100) >>> 0, rel = (fn - stub) | 0;
      dd.write(stub, Uint8Array.from([0xdd, rel & 255, rel >> 8 & 255, rel >> 16 & 255, rel >>> 24 & 255, 0xf0, 0x2c, 0xcb, 0xcb]));
      const r = saved.slice(); r[9] = stub; r[8] = sp; r[0] = d0; r[1] = d1; r[4] = a0; r[5] = a1; dd.m.setRegs(r);
      let n = 0; while ((dd.m.getRegs()[9] >>> 0) !== stub + 7 && n < 3000000) { dd.m.step(); n++; }
      const out = { done: (dd.m.getRegs()[9] >>> 0) === stub + 7, steps: n, d0: dd.m.getRegs()[0] >>> 0 }; dd.m.setRegs(saved); return out;
    };
    const REC = 0xa2100000 + 0x10000, NAME = REC + 0x100;   // scratch RAM the emulator leaves free (checked by the readback)
    const put = (a, bytes) => dd.write(a, Uint8Array.from(bytes));
    const state = (c) => ({ name: c.name, film: c.film });
    for (const c of golden.cases) {
      const pkt = stock(); put(PACKET, pkt);
      put(REC, Buffer.from(c.record, 'hex')); put(NAME, [...Buffer.from(c.name.slice(0, 15), 'latin1'), 0]);
      const r = call(PACKET, REC, c.film, c.name ? NAME : 0);
      const got = Buffer.from(rd(PACKET, PACKET_LEN)), s = got.toString('latin1');
      const i = s.indexOf('xmp:Rating="') + 14, j = s.indexOf('/>', i);
      const text = s.slice(i, j);
      const exp = c.text.replace(/[^\x20-\x7e]/g, '_');
      fmt.cases.push({ ...state(c), call: r, ok: r.done && r.d0 === 1 && text === exp && got.length === PACKET_LEN && s.endsWith('<?xpacket end="w"?>') && s.indexOf('\0') < 0, text_equal: text === exp, got_text: text === exp ? undefined : text });
    }
    // no look: the stock tail only; the packet must come back identical to the stock one
    const s0 = stock(); put(PACKET, s0); const r0 = call(PACKET, 0, 0, 0);
    fmt.cases.push({ name: '(no look: stock packet untouched)', call: r0, ok: r0.done && r0.d0 === 0 && Buffer.from(rd(PACKET, PACKET_LEN)).equals(s0) });
    // a look, then a shot with no COLOR: no cad: field is left, the stock text is back (whitespace padding may differ), same length, end marker last
    put(PACKET, stock()); put(REC, Buffer.from(golden.cases[0].record, 'hex')); put(NAME, [...Buffer.from(golden.cases[0].name, 'latin1'), 0]);
    call(PACKET, REC, golden.cases[0].film, NAME); const rr = call(PACKET, 0, 0, 0);
    const back = Buffer.from(rd(PACKET, PACKET_LEN)).toString('latin1'), squash = (x) => x.replace(/\s+/g, '');
    fmt.cases.push({ name: '(no COLOR after a look: fields gone)', call: rr, ok: rr.done && !back.includes('cad:') && !back.includes('xmlns:cad') && squash(back) === squash(stock().toString('latin1')) && back.length === PACKET_LEN && back.endsWith('<?xpacket end="w"?>') });
    // a packet that is not a built stock packet (all zero): untouched, 0 returned
    put(PACKET, Buffer.alloc(PACKET_LEN)); const rz = call(PACKET, REC, 1, 0);
    fmt.cases.push({ name: '(unbuilt packet)', call: rz, ok: rz.done && rz.d0 === 0 && Buffer.from(rd(PACKET, PACKET_LEN)).equals(Buffer.alloc(PACKET_LEN)) });
    // a packet whose text after the Rating is not a stock tail (nor our fields): untouched even with a record
    const odd = stock(); odd[Buffer.from(odd).toString('latin1').indexOf('xmp:Rating="') + 14] = 0x58; put(PACKET, odd); put(REC, Buffer.from(golden.cases[0].record, 'hex'));
    const ro = call(PACKET, REC, 1, 0);
    fmt.cases.push({ name: '(not a stock tail after the Rating: untouched)', call: ro, ok: ro.done && ro.d0 === 0 && Buffer.from(rd(PACKET, PACKET_LEN)).equals(odd) });
    // a second look over the first (idempotent: nothing left of the earlier one)
    const c0 = golden.cases[0], c1 = golden.cases[1]; put(PACKET, stock());
    for (const c of [c0, c1]) { put(REC, Buffer.from(c.record, 'hex')); put(NAME, [...Buffer.from(c.name, 'latin1'), 0]); call(PACKET, REC, c.film, c.name ? NAME : 0); }
    const s2 = Buffer.from(rd(PACKET, PACKET_LEN)).toString('latin1');
    fmt.cases.push({ name: '(second look replaces the first)', ok: !s2.includes('Portra 400') && s2.includes('cad:Film="' + c1.film + '"') && s2.endsWith('<?xpacket end="w"?>') });
    fmt.ok = fmt.cases.every((c) => c.ok);
  }
}

// ---- XMP_HOOK=1 (with XMP_FMT_DIR, token 's1'): the hook at the stock writer's entry 0x60455cfa. A stock-shaped packet is put in
// the RAM buffer, the writer is entered the way its caller does and run until our stub hands back at 0x60455cff (the
// stock code after the two displaced instructions; running on would reach the ROM helpers the emulator lacks). Checks:
// the hook was taken (cad: fields in the packet, 2301 bytes, end marker last), a1 / d2 / sp are as at entry, and the
// displaced `movbu 255,(a1)` ran. Which COLOR is effective is the emulator's: `effective` reports what the look was.
let hook = null, scen = null;
if (process.env.XMP_HOOK && fmt) {
  const dd = Debugger.attach(lab.sim, {}), BACK = 0x60455cff, XSTATE = 0x62b4dd16, XPOOL = 0xa2852000;
  const head = '<?xpacket begin="\u00ef\u00bb\u00bf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n  <rdf:Description rdf:about=""\n   xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="0"';
  const tail = '/>\n </rdf:RDF>\n</x:xmpmeta>\n', end = '<?xpacket end="w"?>';
  const stockPkt = () => { const pk = Buffer.alloc(PACKET_LEN, 0x20); Buffer.from(head + tail, 'latin1').copy(pk); Buffer.from(end, 'latin1').copy(pk, PACKET_LEN - end.length); return pk; };
  const view = () => { const got = Buffer.from(rd(PACKET, PACKET_LEN)), s = got.toString('latin1'), i = s.indexOf('xmp:Rating="') + 14, j = s.indexOf('/>', i); return { got, s, fields: s.slice(i, j) }; };
  /** Enter the stock writer as its caller does, with `pkt` in the RAM buffer, until our stub hands back at 0x60455cff. */
  const runHook = (pkt = stockPkt()) => {
    const saved = dd.m.getRegs().slice(), sp = ((saved[8] - 0x800) & ~3) >>> 0, stub = (sp - 0x100) >>> 0, B = ((sp - 0x6000) & ~0xff) >>> 0, rel = (WRITER - stub) | 0;
    dd.write(PACKET, pkt); dd.write(B, new Uint8Array(64).fill(0xee));
    dd.write(stub, Uint8Array.from([0xdd, rel & 255, rel >> 8 & 255, rel >> 16 & 255, rel >>> 24 & 255, 0x80, 0x08, 0xcb, 0xcb]));
    const r = saved.slice(); r[9] = stub; r[8] = sp; r[2] = 0x22222222; r[5] = B; r[4] = 0x44444444; r[1] = 0x11111111; dd.m.setRegs(r);
    let n = 0, entrySp = null; while ((dd.m.getRegs()[9] >>> 0) !== BACK && n < 3000000) { if (entrySp === null && (dd.m.getRegs()[9] >>> 0) === WRITER) entrySp = dd.m.getRegs()[8] >>> 0; dd.m.step(); n++; }
    const g = dd.m.getRegs(), out = { reached: (g[9] >>> 0) === BACK, steps: n, a1_kept: (g[5] >>> 0) === B, d2_kept: (g[2] >>> 0) === 0x22222222, d1_kept: (g[1] >>> 0) === 0x11111111, sp_kept: entrySp !== null && (g[8] >>> 0) === entrySp, first_byte: rd(B, 1)[0], ...view() };
    dd.m.setRegs(saved); return out;
  };
  const common = (h) => h.reached && h.a1_kept && h.d2_kept && h.d1_kept && h.sp_kept && h.first_byte === 255 && h.got.length === PACKET_LEN && h.s.endsWith('<?xpacket end="w"?>') && h.s.indexOf('\0') < 0;
  const h0 = runHook();
  hook = { reached: h0.reached, steps: h0.steps, a1_kept: h0.a1_kept, d2_kept: h0.d2_kept, d1_kept: h0.d1_kept, sp_kept: h0.sp_kept, first_byte: h0.first_byte, fields: h0.fields.length, has_version: h0.s.includes('cad:Version="1"'), packet_len: h0.got.length, end_ok: h0.s.endsWith('<?xpacket end="w"?>'), no_nul: h0.s.indexOf('\0') < 0, effective: h0.fields.slice(0, 400) };
  hook.ok = common(h0) && hook.has_version;
  if (process.env.XMP_SCEN) {
    // The look the emulator's COLOR 1 holds is neutral; the state the editor keeps is poked (as the camera's editor would have it).
    const P = XPOOL + (rd(XSTATE, 2)[0] | rd(XSTATE, 2)[1] << 8) - 1, rd32 = (a) => { const b = rd(a, 4); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
    const LPTR = rd32(P + 708), nameAt = (r) => LPTR + 1312 + 16 * r, setName = (r, bytes) => dd.write(nameAt(r), Uint8Array.from([...bytes, ...new Array(16 - bytes.length).fill(0)]));
    const oldLidx = rd(P + 712, 1)[0], oldName = [...rd(nameAt(2), 16)], oldName3 = [...rd(nameAt(4), 16)];
    const ascii = (s) => [...Buffer.from(s, 'latin1')];
    scen = { P: P.toString(16), lptr: LPTR.toString(16), cases: [] };
    const add = (name, ok, extra = {}) => scen.cases.push({ name, ok, ...extra });
    // (a) a film is selected on COLOR 1: look 3 = FILM 3 with the card's name
    dd.write(P + 712, Uint8Array.from([3])); setName(2, ascii('Portra 400'));
    const a = runHook();
    scen.packet_a = a.s;   // the packet as the firmware wrote it (webapp/tests/xmp.test.ts reads it with readCad when XMP_EMU_JSON points at this file)
    add('film selected: Film="3", Look from the bank', common(a) && a.fields.includes(' cad:Look="Portra 400" cad:Film="3" cad:Hue="'), { fields_head: a.fields.slice(0, 200) });
    // (e) the stock rating edit (0x604580c2, `call ..,[d2,d3,a2,a3],24`) on our packet: the digit changes, our fields stay, length stays
    { const after = rd(PACKET + PACKET_LEN, 1)[0]; dd.write(PACKET + PACKET_LEN, Uint8Array.from([0]));   // the stock edit searches a C string: end it (our own writes never touch beyond the end marker)
      const saved = dd.m.getRegs().slice(), sp = ((saved[8] - 0x800) & ~3) >>> 0, stub = (sp - 0x100) >>> 0, rel = (0x604580c2 - stub) | 0;
      dd.write(stub, Uint8Array.from([0xdd, rel & 255, rel >> 8 & 255, rel >> 16 & 255, rel >>> 24 & 255, 0xf0, 0x18, 0xcb, 0xcb]));
      const r = saved.slice(); r[9] = stub; r[8] = sp; r[0] = 3; r[4] = PACKET; dd.m.setRegs(r);
      let n = 0; while ((dd.m.getRegs()[9] >>> 0) !== stub + 7 && n < 120000000) { dd.m.step(); n++; }   // the stock edit searches with a quadratic strstr when the rating is not at +230 (the real packet has it there; this one near it)
      const d0 = dd.m.getRegs()[0] >>> 0, done = (dd.m.getRegs()[9] >>> 0) === stub + 7, stopPc = (dd.m.getRegs()[9] >>> 0).toString(16), trap = done ? undefined : dd.step(1).stderr, a0 = (dd.m.getRegs()[4] >>> 0).toString(16); dd.m.setRegs(saved);
      dd.write(PACKET + PACKET_LEN, Uint8Array.from([after]));
      const v = view();
      add('stock rating edit after our fields: Rating 3, fields intact', done && d0 === 0 && v.s.includes('xmp:Rating="3"') && v.fields === a.fields && v.got.length === PACKET_LEN && v.s.endsWith('<?xpacket end="w"?>'), { d0, done, stopPc, trap, a0 });
      // and our hook on a packet whose rating is already 3 leaves the 3
      const rp = Buffer.from(v.got); const again = runHook(rp);
      add('hook on a rated packet keeps the rating and rewrites the fields', common(again) && again.s.includes('xmp:Rating="3"') && again.fields === a.fields);
    }
    // (c) a name with characters XML does not allow
    setName(2, [...ascii('A&B<"x\''), 0xe9]);
    const c = runHook();
    add('awkward name: Look="A_B__x__", valid text', common(c) && c.fields.includes(' cad:Look="A_B__x__" ') && !/[<>&]/.test(c.fields.replace(/ xmlns:cad="[^"]*"/, '').replace(/cad:\w+="[^"]*"/g, '')), { fields_head: c.fields.slice(0, 160) });
    // (b) no film: COLOR 1's own settings: Film 0 and no Look
    dd.write(P + 712, Uint8Array.from([0]));
    const b0 = runHook();
    add('own settings: Film="0", no Look', common(b0) && b0.fields.includes(' cad:Film="0" ') && !b0.fields.includes('cad:Look='));
    // (d) a second film (look 5 on COLOR 1 = FILM 5) after a first: nothing of the first is left
    dd.write(P + 712, Uint8Array.from([5])); setName(4, ascii('Film Five'));
    const d5 = runHook(Buffer.from(a.got));
    add('film 5 over a packet that held film 3', common(d5) && d5.fields.includes('cad:Film="5"') && !d5.fields.includes('Portra 400') && !d5.fields.includes('cad:Film="3"'));
    // (f) the restore hook at the writer's return, 0x60455d39 (stock: mov 2301,a0; add d2,a0; ret [d2],8), entered as the writer's own frame:
    // after the copy the master packet must be the stock one again (nothing later, e.g. a RAW's metadata, may inherit this shot's look)
    dd.write(P + 712, Uint8Array.from([3])); setName(2, ascii('Portra 400'));
    const f0 = runHook();
    { const saved = dd.m.getRegs().slice(), sp = ((saved[8] - 0x800) & ~3) >>> 0, stub = (sp - 0x100) >>> 0, rel = (0x60455d39 - stub) | 0, D2 = 0xa2100000 + 0x20000;
      dd.write(stub, Uint8Array.from([0xdd, rel & 255, rel >> 8 & 255, rel >> 16 & 255, rel >>> 24 & 255, 0x80, 0x08, 0xcb, 0xcb]));
      const r = saved.slice(); r[9] = stub; r[8] = sp; r[2] = D2; r[4] = 0x44444444; dd.m.setRegs(r);
      let n = 0; while ((dd.m.getRegs()[9] >>> 0) !== stub + 7 && n < 3000000) { dd.m.step(); n++; }
      const g = dd.m.getRegs(), done = (g[9] >>> 0) === stub + 7, a0 = g[4] >>> 0, d2 = g[2] >>> 0; dd.m.setRegs(saved);
      const v = view(), squash = (x) => x.replace(/\s+/g, '');
      add('restore hook: fields gone after the writer copied them, a0 = d2 + 2301, d2 kept', f0.fields.includes('cad:Film="3"') && done && a0 === D2 + 2301 && d2 === D2 && !v.s.includes('cad:') && squash(v.s) === squash(stockPkt().toString('latin1')) && v.got.length === PACKET_LEN && v.s.endsWith('<?xpacket end="w"?>'), { done, a0: a0.toString(16), d2: d2.toString(16), had_fields: f0.fields.length });
    }
    // restore the poked state
    dd.write(P + 712, Uint8Array.from([oldLidx])); dd.write(nameAt(2), Uint8Array.from(oldName)); dd.write(nameAt(4), Uint8Array.from(oldName3));
    scen.ok = scen.cases.every((x) => x.ok);
  }
}

const writer = callWriter();
const res = {
  image: IMAGE, tokens: SCRIPT, packet_len: packet.length,
  starts_ok: text.startsWith('<?xpacket begin='), ends_ok: text.endsWith('<?xpacket end="w"?>'),
  rating_digit_offset: text.indexOf('xmp:Rating="') + 12, rating: text[text.indexOf('xmp:Rating="') + 12],
  cad_present: text.includes('cad:Version="'), exec_hits: hits, writer, fmt, hook, scen, packet_hex: hex(packet),
};
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, packet_hex: undefined }));
if (fmt && !fmt.ok) { console.error('FORMATTER CHECK FAILED:', fmt.cases.filter((c) => !c.ok).map((c) => c.name).join('; ')); process.exitCode = 1; }
if (fmt && fmt.ok) console.log('FORMATTER CHECK PASSED:', fmt.cases.length, 'cases');
if (hook && !hook.ok) { console.error('HOOK CHECK FAILED', JSON.stringify(hook)); process.exitCode = 1; }
if (hook && hook.ok) console.log('HOOK CHECK PASSED');
if (scen) { for (const c of scen.cases) console.log(c.ok ? '  ok  ' : '  FAIL', c.name); if (!scen.ok) { console.error('SCENARIOS FAILED'); process.exitCode = 1; } else console.log('SCENARIOS PASSED:', scen.cases.length); }

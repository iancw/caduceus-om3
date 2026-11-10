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
    // a second look over the first (idempotent: nothing left of the earlier one)
    const c0 = golden.cases[0], c1 = golden.cases[1]; put(PACKET, stock());
    for (const c of [c0, c1]) { put(REC, Buffer.from(c.record, 'hex')); put(NAME, [...Buffer.from(c.name, 'latin1'), 0]); call(PACKET, REC, c.film, c.name ? NAME : 0); }
    const s2 = Buffer.from(rd(PACKET, PACKET_LEN)).toString('latin1');
    fmt.cases.push({ name: '(second look replaces the first)', ok: !s2.includes('Portra 400') && s2.includes('cad:Film="' + c1.film + '"') && s2.endsWith('<?xpacket end="w"?>') });
    fmt.ok = fmt.cases.every((c) => c.ok);
  }
}

const writer = callWriter();
const res = {
  image: IMAGE, tokens: SCRIPT, packet_len: packet.length,
  starts_ok: text.startsWith('<?xpacket begin='), ends_ok: text.endsWith('<?xpacket end="w"?>'),
  rating_digit_offset: text.indexOf('xmp:Rating="') + 12, rating: text[text.indexOf('xmp:Rating="') + 12],
  cad_present: text.includes('cad:Version="'), exec_hits: hits, writer, fmt, packet_hex: hex(packet),
};
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, packet_hex: undefined }));
if (fmt && !fmt.ok) { console.error('FORMATTER CHECK FAILED'); process.exit(1); }
if (fmt) console.log('FORMATTER CHECK PASSED:', fmt.cases.length, 'cases');

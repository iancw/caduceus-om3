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
if (TRACE.length) Debugger.attach(lab.sim, { lab }).traceExec((r) => { const k = r.pc.toString(16); hits[k] = (hits[k] || 0) + 1; }, { pcs: TRACE });
s.idle_slice(lab.lab_time() + 1500e6);
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
const writer = callWriter();
const res = {
  image: IMAGE, tokens: SCRIPT, packet_len: packet.length,
  starts_ok: text.startsWith('<?xpacket begin='), ends_ok: text.endsWith('<?xpacket end="w"?>'),
  rating_digit_offset: text.indexOf('xmp:Rating="') + 12, rating: text[text.indexOf('xmp:Rating="') + 12],
  cad_present: text.includes('cad:Version="'), exec_hits: hits, writer, packet_hex: hex(packet),
};
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ ...res, packet_hex: undefined }));

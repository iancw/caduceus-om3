// Creative Dial trace (emulator only): logs d0/d1/d2 at the dial-position -> setting-id step (0x610934e8..0x6109356b) for each flip. OUTD=DIR OM_EMU_MODEL=E147 ORDER=0,1,2,3,4 node dial_trace.mjs EMU_DIR MAIN_BLOCK CARD.omsd
const [EMU, IMAGE, CARD] = process.argv.slice(2);
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const zlib = await import('node:zlib');
const { expandImage } = await import(EMU + '/src/fw/expand.mjs');
const { loadBlock } = await import(EMU + '/bin/run.mjs');
const { Player } = await import(EMU + '/src/lab/player.mjs');
const { PLAYER_PARSER } = await import(EMU + '/scenarios/session_replay.mjs');
const { cardFromImage } = await import(EMU + '/src/lab/sdcard.mjs');
const play = await import(EMU + '/src/lab/play.mjs');
let c0 = cardFromImage(new Uint8Array(fs.readFileSync(CARD)));
const card = { open: () => c0, save: (x) => { c0 = x; } };
const rom = expandImage(new Uint8Array(fs.readFileSync(IMAGE)));
const env = { rom, resBlock: loadBlock(), createHash, card,
  deflate: (b, l) => new Uint8Array(zlib.deflateSync(b, { level: l })), inflate: (b) => new Uint8Array(zlib.inflateSync(b)) };
const pl = new Player({ ...PLAYER_PARSER, no_browser: true, idle: 'off', a15: 'on', out: '<out>', no_wait_on_error: true, device: 'tft' },
  { ...env, wallClock: () => performance.now() / 1000 });
pl.open_session();
const s = pl.session, lab = s.lab;
s.idle_slice(lab.lab_time() + 1500e6);
const { groups } = play.uiin_layout(rom);
groups.forEach((g, i) => console.log('group', i, 'bytes', g.bytes, 'bits', g.bits, 'entries', g.entries.length, 'codes', [...new Set(g.entries.map((e) => e[2].toString(16)))].join(',')));
const pos = [];
groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1909) pos.push([gi, b, bit, pol]); }));
console.log('creative dial positions [group,byte,bit,pol]:', JSON.stringify(pos));
console.log('image bytes', pos.map(([g]) => Buffer.from(s.images[g]).toString('hex')).join(' '));


const { Debugger } = await import(EMU + '/src/debug/debugger.mjs');
const dd = Debugger.attach(lab.sim, { lab });
lab.sim.write(0xa32de590, new Uint8Array([0xff, 0x03, 0, 0])); lab.sim.write(0x60369308, new Uint8Array([0x00, 0xf0, 0, 0]));
const grp5 = []; groups.forEach((g, gi) => g.entries.forEach(([b, bit, code, typ, pol]) => { if (code === 0x1906) grp5.push([gi, b, bit, pol]); }));
const seq = (process.env.ORDER || '3').split(',').map(Number);
const flip = (k) => { grp5.forEach(([g2, b2, bit2, pol2], j) => play.set_bit(s.images[g2], b2, bit2, j === k ? pol2 : 1 - pol2)); s.push_group(5); s.camapp.pump(); s.idle_slice(lab.lab_time() + 800e6); };

const PCS = [0x610934e8, 0x6109354d, 0x6109356b, 0x61093583, 0x61093555];
for (const k of seq) {
  const hits = [];
  dd.traceExec((r) => { hits.push(r.pc.toString(16) + ' d0=' + (r.d0 | 0) + ' d1=' + (r.d1 | 0) + ' d2=' + (r.d2 | 0)); }, { pcs: PCS });
  flip(k);
  dd.traceExec(null);
  console.log('pos', k, lab.state_names.get(lab.state()) ?? lab.state(), '\n  ' + hits.join('\n  '));
}

/* WRONGSIDE online server v2: serves the game AND runs rooms (Socket.IO). */
const http = require("http"), fs = require("fs"), path = require("path");
const MAXP = 8, CH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", MODES = ["normal", "night", "voice"];
function attach(io) {
  const rooms = new Map();
  const code = () => { let c; do { c = Array.from({ length: 5 }, () => CH[Math.random() * CH.length | 0]).join(""); } while (rooms.has(c)); return c; };
  const clean = s => String(s || "").replace(/[^\w \-]/g, "").trim().slice(0, 12) || "PLAYER";
  const seed = () => Math.random() * 4294967296 >>> 0;
  const info = r => ({ code: r.code, name: r.name, players: r.p.size, max: MAXP, state: r.state, mode: r.mode });
  const lobby = (r, pull) => ({ code: r.code, name: r.name, mode: r.mode, state: r.state, host: r.host, pull: !!pull, players: [...r.p].map(([id, p]) => ({ id, name: p.name, ready: p.ready, down: p.down })) });
  const pushLobby = (r, pull) => io.to(r.code).emit("lobby", lobby(r, pull));
  function checkWipe(r) { if (r.state === "playing" && r.p.size && [...r.p.values()].every(p => p.down)) io.to(r.code).emit("wipe"); }
  function leave(s) {
    const c = s.data.room; if (!c) return; s.data.room = null; s.leave(c);
    const r = rooms.get(c); if (!r) return; r.p.delete(s.id); s.to(c).emit("pl", s.id);
    if (!r.p.size) { rooms.delete(c); return; } if (r.host === s.id) r.host = [...r.p.keys()][0];
    pushLobby(r); checkWipe(r);
  }
  function join(s, r, name, cb) {
    if (r.p.size >= MAXP) return cb({ ok: false, err: "ROOM FULL" });
    const others = [...r.p].map(([id, p]) => ({ id, name: p.name }));
    r.p.set(s.id, { name: clean(name), st: null, ready: r.host === s.id, down: false }); s.join(r.code); s.data.room = r.code;
    s.to(r.code).emit("pj", { id: s.id, name: clean(name) }); pushLobby(r);
    cb({ ok: true, code: r.code, seed: r.seed, mode: r.mode, state: r.state, got: [...r.got], players: others, lobby: lobby(r) });
  }
  const mine = s => { const r = rooms.get(s.data.room); return r && r.p.has(s.id) ? r : null; };
  io.on("connection", s => {
    s.data = s.data || {};
    s.on("rooms", cb => { if (typeof cb === "function") cb([...rooms.values()].filter(r => r.p.size < MAXP).map(info)); });
    s.on("room:create", (d, cb) => {
      if (typeof cb !== "function") return; leave(s); const c = code();
      const r = { code: c, name: clean(d && d.name) + "'S ROOM", seed: seed(), mode: "normal", state: "lobby", host: s.id, p: new Map(), got: new Set(), cs: false }; rooms.set(c, r); join(s, r, d && d.name, cb);
    });
    s.on("room:join", (d, cb) => {
      if (typeof cb !== "function") return; const c = String(d && d.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), r = rooms.get(c);
      if (!r) return cb({ ok: false, err: "ROOM NOT FOUND" });
      if (s.data.room === c) return cb({ ok: true, code: c, seed: r.seed, mode: r.mode, state: r.state, got: [...r.got], players: [...r.p].filter(([id]) => id !== s.id).map(([id, p]) => ({ id, name: p.name })), lobby: lobby(r) });
      leave(s); join(s, r, d && d.name, cb);
    });
    s.on("room:leave", () => leave(s));
    s.on("room:mode", m => { const r = mine(s); if (r && r.host === s.id && r.state === "lobby" && MODES.includes(m)) { r.mode = m; r.p.forEach((p, id) => { p.ready = id === r.host; }); pushLobby(r); } });
    s.on("room:ready", b => { const r = mine(s); if (r && r.state === "lobby") { r.p.get(s.id).ready = !!b || r.host === s.id; pushLobby(r); } });
    s.on("room:start", () => {
      const r = mine(s); if (!r || r.host !== s.id || r.state !== "lobby" || ![...r.p.values()].every(p => p.ready)) return;
      r.state = "playing"; r.seed = seed(); r.got.clear(); r.cs = false; r.p.forEach(p => { p.down = false; p.st = null; });
      io.to(r.code).emit("start", { seed: r.seed, mode: r.mode }); pushLobby(r);
    });
    s.on("room:retry", () => { const r = mine(s); if (!r || r.state === "lobby") return; r.state = "lobby"; r.got.clear(); r.cs = false; r.p.forEach((p, id) => { p.ready = id === r.host; p.down = false; }); pushLobby(r, true); });
    s.on("st", a => { const r = mine(s), p = r && r.p.get(s.id); if (p && Array.isArray(a) && a.length === 5 && a.every(Number.isFinite)) p.st = a; });
    s.on("door", a => { if (s.data.room && Array.isArray(a) && Number.isInteger(a[0]) && a[0] >= 0 && a[0] < 64) s.to(s.data.room).emit("door", [a[0], a[1] ? 1 : 0]); });
    s.on("ev", a => {
      const r = mine(s); if (!r || !a || r.state !== "playing") return; const me = r.p.get(s.id), num = v => Number(v) || 0;
      if (a.t === "dead") { me.down = true; s.to(r.code).emit("ev", { id: s.id, t: "dead", x: num(a.x), z: num(a.z), y: num(a.y) }); checkWipe(r); }
      else if (a.t === "revive") {
        const tid = String(a.to || ""), tp = r.p.get(tid); if (!tp || !tp.down || me.down) return; tp.down = false;
        io.to(tid).emit("rev"); io.to(r.code).emit("ev", { id: tid, t: "alive", by: s.id });
      }
      else if (a.t === "film") { const i = String(a.i || "").slice(0, 24); if (i && !r.got.has(i)) { r.got.add(i); s.to(r.code).emit("ev", { id: s.id, t: "film", i }); } }
      else if (a.t === "cs") { if (!r.cs) { r.cs = true; s.to(r.code).emit("cs"); } }
      else if (a.t === "win") { r.state = "lobby"; r.p.forEach((p, id) => { p.ready = id === r.host; p.down = false; }); s.to(r.code).emit("win"); }
    });
    s.on("disconnect", () => leave(s));
  });
  return setInterval(() => {
    for (const r of rooms.values()) { if (r.p.size < 2 || r.state !== "playing") continue; const o = {}; r.p.forEach((p, id) => { if (p.st) o[id] = p.st; }); io.to(r.code).emit("snap", o); }
  }, 66);
}
module.exports = { attach };
if (require.main === module) {
  const { Server } = require("socket.io"), FILE = [path.join(__dirname, "index.html"), path.join(__dirname, "public", "index.html")].find(f => fs.existsSync(f)) || path.join(__dirname, "index.html");
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") { res.end("ok"); return; }
    fs.readFile(FILE, (e, d) => { if (e) { res.writeHead(500); res.end("Upload index.html next to server.js"); return; } res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(d); });
  });
  attach(new Server(srv, { cors: { origin: "*" } }));
  const PORT = process.env.PORT || 3000; srv.listen(PORT, () => console.log("WRONGSIDE server on http://localhost:" + PORT));
}

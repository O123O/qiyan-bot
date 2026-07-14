// All client styling in one string, injected via <style>. Themes switch on <html data-theme>.
export const STYLES = `
:root, :root[data-theme="dark"] { color-scheme: dark;
  --bg:#0f1720; --panel:#17212b; --panel2:#1e2b36; --line:#26333f; --muted:#8aa0b0; --accent:#16b8a6; --accent-fg:#04110f; --text:#e6eef2; --code:#0b1219; --you:#193040; }
:root[data-theme="light"] { color-scheme: light;
  --bg:#f6f8fa; --panel:#ffffff; --panel2:#eef2f5; --line:#d6dee6; --muted:#5b6b78; --accent:#0f8f83; --accent-fg:#ffffff; --text:#111b22; --code:#f0f3f6; --you:#e3f0ee; }
* { box-sizing:border-box; }
body { margin:0; }
.app { font:14px/1.55 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }

.topbar { display:flex; align-items:center; gap:14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
.brand { font-weight:700; letter-spacing:.5px; color:var(--accent); }
.tabs { display:flex; gap:6px; overflow-x:auto; flex:1; }
.tab { display:flex; align-items:center; gap:6px; background:transparent; color:var(--muted); border:1px solid transparent; border-radius:999px; padding:5px 12px; cursor:pointer; white-space:nowrap; font-size:13px; }
.tab:hover { background:var(--panel2); }
.tab.on { color:var(--text); background:var(--panel2); border-color:var(--line); }
.dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.dot.idle { background:#3fd68a; } .dot.busy { background:#f5b13d; } .dot.other { background:#7d93a3; }
.right { display:flex; align-items:center; gap:10px; }
.live { font-size:12px; color:var(--muted); } .live.on { color:#3fd68a; }
.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:5px 9px; cursor:pointer; }

.body { flex:1; display:flex; min-height:0; }
.files { width:290px; flex:0 0 auto; border-right:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
.files-head { padding:11px 14px; border-bottom:1px solid var(--line); font-weight:600; }
.tree { overflow-y:auto; padding:8px; }
.crumbs { color:var(--muted); font-size:12px; margin-bottom:8px; word-break:break-all; } .crumbs a { color:var(--accent); cursor:pointer; }
.frow { padding:5px 8px; border-radius:6px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.frow:hover { background:var(--panel2); } .frow.dir { font-weight:600; } .frow.other { color:var(--muted); cursor:default; }
.hint { color:var(--muted); padding:10px 8px; font-size:13px; }

.chat { flex:1; display:flex; flex-direction:column; min-width:0; }
.log { flex:1; overflow-y:auto; padding:16px 18px; }
.empty { color:var(--muted); text-align:center; margin-top:40px; }
.msg { border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin-bottom:10px; background:var(--panel); }
.msg.you { background:var(--you); margin-left:15%; }
.msg .when { color:var(--muted); font-size:11px; margin-bottom:4px; }
.md { word-break:break-word; } .md > *:first-child { margin-top:0; } .md > *:last-child { margin-bottom:0; }
.md p { margin:.4em 0; } .md pre { background:var(--code); padding:10px 12px; border-radius:8px; overflow-x:auto; border:1px solid var(--line); }
.md code { background:var(--code); padding:.1em .35em; border-radius:5px; font-size:.92em; } .md pre code { padding:0; background:transparent; }
.md a { color:var(--accent); } .md table { border-collapse:collapse; } .md td, .md th { border:1px solid var(--line); padding:4px 8px; }
.md blockquote { margin:.4em 0; padding-left:10px; border-left:3px solid var(--line); color:var(--muted); }

.composer { position:relative; border-top:1px solid var(--line); padding:10px 14px; display:flex; gap:8px; background:var(--panel); }
.composer textarea { flex:1; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; resize:none; font:inherit; }
.composer button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:8px; padding:0 18px; cursor:pointer; font-weight:600; }
.suggest { position:absolute; bottom:calc(100% + 4px); left:14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; box-shadow:0 6px 20px rgba(0,0,0,.3); }
.srow { padding:6px 14px; cursor:pointer; } .srow:hover, .srow.on { background:var(--panel2); }

.modal { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:5vh 5vw; }
.sheet { background:var(--panel); border:1px solid var(--line); border-radius:12px; width:min(900px,100%); max-height:100%; display:flex; flex-direction:column; }
.sheet-head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid var(--line); font-family:monospace; word-break:break-all; }
.sheet-body { overflow:auto; padding:14px; } .sheet-body pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12.5px/1.5 monospace; }
`;

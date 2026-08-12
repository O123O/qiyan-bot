// All client styling in one string, injected via <style>. Themes switch on <html data-theme>.
export const STYLES = `
:root, :root[data-theme="dark"] { color-scheme: dark;
  --bg:#0f1720; --panel:#17212b; --panel2:#1e2b36; --line:#26333f; --muted:#8aa0b0; --accent:#16b8a6; --accent-fg:#04110f; --text:#e6eef2; --code:#0b1219; --you:#193040; --qiyan-border:#168f85; --worker-relay-border:#8d70bd;
  --hl-bg:#0d1117; --hl-fg:#c9d1d9; --hl-comment:#8b949e; --hl-kw:#ff7b72; --hl-str:#a5d6ff; --hl-num:#79c0ff; --hl-title:#d2a8ff; --hl-attr:#7ee787; --hl-type:#ffa657; }
:root[data-theme="light"] { color-scheme: light;
  --bg:#f6f8fa; --panel:#ffffff; --panel2:#eef2f5; --line:#d6dee6; --muted:#5b6b78; --accent:#0f8f83; --accent-fg:#ffffff; --text:#111b22; --code:#f0f3f6; --you:#e3f0ee; --qiyan-border:#0f8f83; --worker-relay-border:#7e56a8;
  --hl-bg:#f6f8fa; --hl-fg:#24292e; --hl-comment:#6a737d; --hl-kw:#d73a49; --hl-str:#032f62; --hl-num:#005cc5; --hl-title:#6f42c1; --hl-attr:#22863a; --hl-type:#e36209; }
* { box-sizing:border-box; }
body { margin:0; }
.app { font:14px/1.55 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }

.topbar { display:flex; align-items:center; gap:14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
.brand { width:32px; height:32px; object-fit:contain; flex:0 0 auto; border-radius:8px; }
.tabs { display:flex; gap:6px; overflow-x:auto; overflow-y:hidden; flex:1; scrollbar-width:thin; }
.tabs::-webkit-scrollbar { height:6px; } .tabs::-webkit-scrollbar-thumb { background:var(--line); border-radius:3px; }
.tab { flex:0 0 auto; display:flex; align-items:center; gap:6px; background:transparent; color:var(--muted); border:1px solid transparent; border-radius:999px; padding:5px 12px; cursor:pointer; white-space:nowrap; font-size:13px; }
.tab:hover { background:var(--panel2); }
.tab.on { color:var(--text); background:var(--panel2); border-color:var(--line); }
.tab-copy { display:flex; flex-direction:column; align-items:flex-start; line-height:1.1; }
.tab-status { color:var(--muted); font-size:10px; }
.dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.dot.idle { background:#3fd68a; } .dot.working { background:#f5b13d; } .dot.error { background:#ef6b73; } .dot.unavailable, .dot.other { background:#7d93a3; }
.right { display:flex; align-items:center; gap:10px; }
.live { font-size:12px; color:var(--muted); } .live.on { color:#3fd68a; }
.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:5px 9px; cursor:pointer; }

.body { flex:1; display:flex; min-height:0; }
.files { flex:0 0 auto; border-right:1px solid var(--line); background:var(--panel); display:flex; flex-direction:column; min-height:0; overflow:hidden; }
.resizer { flex:0 0 5px; cursor:col-resize; background:transparent; } .resizer:hover { background:var(--accent); }
.tw { display:inline-block; width:1.1em; color:var(--muted); }
.tabs2 { display:flex; gap:4px; } .tabs2 button { background:transparent; border:0; color:var(--muted); cursor:pointer; padding:2px 8px; border-radius:6px; font-weight:600; } .tabs2 button.on { color:var(--text); background:var(--panel2); } .tabs2 button:disabled { opacity:.45; cursor:default; }
.git-toolbar { display:flex; gap:6px; padding:6px 8px; }
.discover { border:1px solid var(--line); border-radius:8px; margin:0 8px 8px; padding:4px; }
.grepo { border:1px solid var(--line); border-radius:8px; margin:0 8px 8px; overflow:hidden; }
.grepo-h { display:flex; align-items:center; gap:4px; padding:6px 8px; background:var(--panel2); font-size:12px; font-weight:600; }
.grepo-h .actions { display:flex; } /* repo header actions always visible */
.gsec-h { padding:4px 10px; font-size:11px; text-transform:uppercase; color:var(--muted); letter-spacing:.5px; }
.commit { border-top:1px solid var(--line); margin-top:8px; padding:10px; display:flex; flex-direction:column; gap:6px; }
.commit textarea { background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 8px; resize:none; font:inherit; }
.commit button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:8px; padding:6px; cursor:pointer; font-weight:600; } .commit button:disabled { opacity:.45; cursor:default; }
.files-head { padding:8px 14px; border-bottom:1px solid var(--line); font-weight:600; display:flex; align-items:center; justify-content:space-between; }
.filesystem-nav { display:flex; gap:5px; padding:7px 8px; border-bottom:1px solid var(--line); }
.filesystem-nav input { min-width:0; flex:1; padding:5px 7px; border:1px solid var(--line); border-radius:5px; background:var(--bg); color:var(--text); font:inherit; }
.ghost.sm { padding:2px 8px; font-size:15px; line-height:1; }
.older { align-self:center; background:transparent; border:0; color:var(--muted); cursor:pointer; font:inherit; font-size:12px; margin:0; padding:6px 10px 10px; }
.older:hover:not(:disabled) { color:var(--text); text-decoration:underline; }
.older:disabled { cursor:default; }
.file-link { background:transparent; border:0; padding:0; color:var(--accent); cursor:pointer; font:inherit; text-decoration:underline; }
.tree { overflow-y:auto; padding:8px; }
.crumbs { color:var(--muted); font-size:12px; margin-bottom:8px; word-break:break-all; } .crumbs a { color:var(--accent); cursor:pointer; }
.frow { display:flex; align-items:center; gap:2px; padding:5px 8px 5px 0; border-radius:6px; cursor:pointer; white-space:nowrap; }
.frow:hover { background:var(--panel2); } .frow.dir { font-weight:600; } .frow.other { color:var(--muted); cursor:default; }
.fname { flex:1; overflow:hidden; text-overflow:ellipsis; }
.actions { display:none; gap:2px; flex:0 0 auto; padding-right:4px; } .frow:hover .actions { display:flex; }
.actions button { background:transparent; border:0; cursor:pointer; font-size:12px; padding:0 3px; opacity:.8; } .actions button:hover { opacity:1; }
.hint { color:var(--muted); padding:10px 8px; font-size:13px; }

.chat { flex:1; display:flex; flex-direction:column; min-width:0; }
.log { flex:1; overflow-y:auto; padding:16px 18px; }
.empty { color:var(--muted); text-align:center; margin-top:40px; }
.msg { border:1px solid var(--line); border-radius:10px; padding:8px 12px; margin-bottom:10px; background:var(--panel); }
.msg.you { background:var(--you); margin-left:15%; }
.msg.qiyan { border-color:var(--qiyan-border); }
.msg.worker-relay { border-color:var(--worker-relay-border); }
.msg .when { color:var(--muted); font-size:11px; margin-bottom:4px; }
.worker-mention { padding:0; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.worker-mention:hover, .worker-mention:focus-visible { color:var(--accent); text-decoration:underline; }
.md { word-break:break-word; } .md > *:first-child { margin-top:0; } .md > *:last-child { margin-bottom:0; }
/* pre-wrap, not pre: every space and newline is kept, but a long line still wraps to the
   panel instead of forcing the conversation to scroll sideways. Same font as the composer, so
   what you sent looks like what you typed. */
.verbatim { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font:inherit; }
.md p { margin:.4em 0; } .md pre { margin:.4em 0; border:1px solid var(--line); border-radius:8px; overflow:auto; }
.md code:not(.hljs) { background:var(--code); padding:.1em .35em; border-radius:5px; font-size:.92em; } /* inline code only */
.code-view, .md pre .hljs { margin:0; border-radius:8px; font:12.5px/1.5 monospace; }
/* Sized by the layout, not by guessing the modal's chrome from vh. .sheet is a fixed-height
   flex column, so .sheet-body is a flex context and this child shrinks to the space available,
   then scrolls internally while .sheet-body does not. What lets it shrink is overflow:auto --
   a flex item whose overflow is not visible has an automatic minimum size of 0 (Flexbox 4.5),
   which is also why a tall .md sibling does NOT shrink and still scrolls the body. min-height:0
   is belt-and-braces; it measures as a no-op. Guessing this from the viewport instead produced
   two nested scrollbars above 1440p, where a calc against 100vh outran a sheet sized in 92vh. */
.code-view { border:1px solid var(--line); overflow:auto; min-height:0; }
/* .sheet-body pre.code-view, not .code-view: the .sheet-body pre rule is (0,1,1) and outranks
   win, keeping pre-wrap. Source must not soft-wrap on EITHER path -- above the numbering cap
   the viewer falls back to a single block, and reusing the prose markup silently coupled
   "no line numbers" to "soft-wrapped", so this repo's own 5,767-line production-app.ts
   rendered at ~198% height with continuations at column zero. */
.sheet-body pre.code-view { white-space:pre; word-break:normal; }
/* :not(.code-lines) keeps this off the numbered path, and takes the selector to (0,2,1) --
   a plain .code-view > code selector is (0,1,1) and would TIE code.code-lines, benign only
   while the values happen to agree. Same defect as the grid's overflow:visible: the palette
   makes this element its own scrollport, so the horizontal scrollbar sits at the bottom of the
   whole file -- ~107,000px down in production-app.ts -- instead of at the bottom of the view.
   Inert while this path wrapped; live the moment it stopped. */
.code-view > code:not(.code-lines) { overflow:visible; width:max-content; min-width:100%; }
/* One grid row per source line. The gutter column is sized to the widest line number, so a
   1000-line file does not shift its code sideways relative to a 100-line one, and a wrapped
   line keeps its number pinned to the row's first visual line rather than drifting. */
/* Source must not wrap: a wrapped line breaks the correspondence between one line and one
   number, and reading indented code whose continuations start at column zero is worse than
   scrolling. The grid is sized to its widest line so .code-view scrolls horizontally, and
   min-width keeps it filling the panel when the file is narrow. */
/* code.code-lines, not .code-lines: the .hljs palette rule below sets display:block at equal
   specificity and later in the sheet, so a bare class here loses the cascade and every line
   lays out inline -- the whole file on one line. Also drop the palette padding, which would
   otherwise indent the gutter away from the edge. */
code.code-lines {
  display:grid; grid-template-columns:max-content max-content; width:max-content; min-width:100%;
  /* The palette rule sets FOUR properties on .hljs and every one of them has to be answered
     here. overflow was the one missed: .hljs{overflow-x:auto} made this element its own
     scrollport, so the sticky gutter resolved against a box that never scrolls and the numbers
     scrolled away with the code. Scrolling belongs to .code-view. */
  overflow:visible;
  /* var(--hl-bg), never inherit: the ancestors are transparent, so inherit overrode the
     palette background with nothing -- the viewer lost its code background, and code would
     scroll visibly through the numbers. */
  background:var(--hl-bg); padding:8px 0;
}
.code-line { display:contents; }
.code-view .code-gutter {
  /* min-width, never width: the number must be free to exceed the reserved column. Pinned to
     an exact width it inherits pre-wrap and break-word from the prose preview rule and breaks
     INSIDE a number, so "15" stacks as 1 over 5. Its own white-space/word-break settings are
     what actually stop that; the min-width only reserves alignment. */
  min-width:var(--gutter,2ch); padding:0 10px 0 4px; text-align:right;
  white-space:pre; word-break:normal; overflow-wrap:normal;
  /* Dimmed through the colour, never through opacity: opacity fades the whole box, background
     included, so code would show through the numbers however opaque the background is set. */
  color:var(--muted); user-select:none; -webkit-user-select:none;
  border-right:1px solid var(--line);
  /* Sticky so the numbers survive scrolling a wide file sideways, over an opaque background so
     nothing scrolls through them. */
  position:sticky; left:0; background:var(--hl-bg); z-index:1;
}
/* Overrides the .sheet-body pre rule, which soft-wraps prose previews. */
.code-view .code-text { white-space:pre; word-break:normal; overflow-wrap:normal; padding-left:10px; }
/* highlight.js palette follows the app theme (github light/dark) */
.hljs { display:block; overflow-x:auto; padding:12px; background:var(--hl-bg); color:var(--hl-fg); }
.hljs-comment,.hljs-quote { color:var(--hl-comment); font-style:italic; }
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-name,.hljs-tag,.hljs-literal,.hljs-deletion { color:var(--hl-kw); }
.hljs-string,.hljs-attr,.hljs-regexp,.hljs-addition,.hljs-meta .hljs-string { color:var(--hl-str); }
.hljs-number,.hljs-variable,.hljs-template-variable,.hljs-selector-attr,.hljs-selector-pseudo { color:var(--hl-num); }
.hljs-title,.hljs-section,.hljs-symbol,.hljs-bullet { color:var(--hl-title); }
.hljs-attribute,.hljs-meta,.hljs-selector-id,.hljs-selector-class,.hljs-type,.hljs-params { color:var(--hl-type); }
.hljs-emphasis { font-style:italic; } .hljs-strong { font-weight:700; }
.md a { color:var(--accent); } .md table { border-collapse:collapse; } .md td, .md th { border:1px solid var(--line); padding:4px 8px; }
.md blockquote { margin:.4em 0; padding-left:10px; border-left:3px solid var(--line); color:var(--muted); }

.goal-row { border-top:1px solid var(--line); padding:8px 14px; background:var(--panel); display:flex; align-items:flex-start; gap:12px; }
.goal-meta { flex:0 0 auto; display:flex; align-items:center; gap:7px; padding-top:1px; }
.goal-label { font-weight:700; }
.goal-status { display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
.goal-status::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--muted); }
.goal-status[data-status="active"]::before, .goal-status[data-status="complete"]::before { background:#3fd68a; }
.goal-status[data-status="paused"]::before, .goal-status[data-status="usageLimited"]::before, .goal-status[data-status="budgetLimited"]::before { background:#f5b13d; }
.goal-status[data-status="blocked"]::before { background:#ef6b73; }
.goal-objective { min-width:0; max-height:4.65em; overflow:auto; white-space:pre-wrap; word-break:break-word; }

.tasks-row { border-top:1px solid var(--line); padding:6px 14px; background:var(--panel); display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; }
.tasks-spinner { flex:0 0 auto; width:8px; height:8px; border-radius:50%; background:#4aa3ff; animation:tasks-pulse 1.4s ease-in-out infinite; }
.tasks-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@keyframes tasks-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }

.composer { position:relative; border-top:1px solid var(--line); padding:10px 14px; display:flex; gap:8px; background:var(--panel); }
.composer textarea { flex:1; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; resize:none; font:inherit; }
.composer button { background:var(--accent); color:var(--accent-fg); border:0; border-radius:8px; padding:0 18px; cursor:pointer; font-weight:600; }
.worker-context { border-top:1px solid var(--line); padding:5px 14px 7px; background:var(--panel2); color:var(--muted); display:flex; flex-wrap:wrap; gap:4px 14px; font-size:11px; }
.worker-context strong { color:var(--text); font-weight:500; overflow-wrap:anywhere; }
.suggest { position:absolute; bottom:calc(100% + 4px); left:14px; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; box-shadow:0 6px 20px rgba(0,0,0,.3); }
.srow { padding:6px 14px; cursor:pointer; } .srow:hover, .srow.on { background:var(--panel2); }
.command-suggest { width:min(520px,calc(100% - 28px)); }
.command-row { display:flex; align-items:baseline; gap:14px; }
.command-label { flex:0 0 190px; color:var(--text); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
.command-description { min-width:0; color:var(--muted); font-size:12px; }

.modal { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; padding:4vh 4vw; }
.sheet { background:var(--panel); border:1px solid var(--line); border-radius:12px; width:min(1240px,96vw); height:92vh; max-height:100%; display:flex; flex-direction:column; box-shadow:0 12px 44px rgba(0,0,0,.45); }
.sheet-head { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); font-family:monospace; word-break:break-all; }
.head-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.sheet-body { overflow:auto; padding:14px; display:flex; flex-direction:column; min-height:0; } .sheet-body pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12.5px/1.5 monospace; }
.preview-img { max-width:100%; max-height:78vh; object-fit:contain; display:block; margin:0 auto; }
/* Figures inside rendered markdown. Capped so a full-resolution screenshot cannot push the
   document into a horizontal scroll, and clickable because the cap makes detail unreadable. */
.md img.md-img { max-width:100%; height:auto; display:block; margin:8px 0; border-radius:6px; cursor:zoom-in; }
.md img.md-img[alt]:after { content:attr(alt); }
`;

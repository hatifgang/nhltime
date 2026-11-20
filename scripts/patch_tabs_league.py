import sys
P = sys.argv[1] if len(sys.argv) > 1 else 'public/index.html'
league = sys.argv[2] if len(sys.argv) > 2 else 'NHL'
s = open(P, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


# Onglets : sur ordinateur ils passent à la ligne (tout est visible), sur téléphone on garde le défilement au doigt.
rep("nav.tabs button{font-family", """@media (min-width:700px){nav.tabs{flex-wrap:wrap;overflow-x:visible;row-gap:0}}
nav.tabs{cursor:grab} nav.tabs.drag{cursor:grabbing}
.league{display:inline-flex;justify-self:end;border:1px solid var(--accent);border-radius:8px;overflow:hidden;margin-bottom:4px}
.league a{font-family:var(--f-display);font-weight:700;font-size:1.05rem;letter-spacing:.08em;padding:5px 18px;color:var(--accent);text-decoration:none}
.league a[aria-current="page"]{background:var(--accent);color:var(--surface)}
.league a:focus-visible{outline:2px solid var(--fg);outline-offset:-2px}
@media (max-width:560px){.league{justify-self:start}}
nav.tabs button{font-family""")
cur_nhl = ' aria-current="page"' if league == 'NHL' else ''
cur_nba = ' aria-current="page"' if league == 'NBA' else ''
rep('<div class="status"><span>Dernier passage</span>',
    f'<div class="status"><nav class="league" aria-label="Championnat"><a href="/"{cur_nhl}>NHL</a><a href="/nba.html"{cur_nba}>NBA</a></nav><span>Dernier passage</span>')
# Molette et glisser à la souris sur la barre d'onglets (largeurs intermédiaires où elle défile encore)
rep("let D = null;", """let D = null;
(() => { const n = document.getElementById('tabs'); if(!n) return;
  n.addEventListener('wheel', e => { if(n.scrollWidth > n.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)){ n.scrollLeft += e.deltaY; e.preventDefault(); } }, {passive:false});
  let x0 = null, s0 = 0, moved = false;
  n.addEventListener('pointerdown', e => { if(e.pointerType !== 'mouse' || n.scrollWidth <= n.clientWidth) return; x0 = e.clientX; s0 = n.scrollLeft; moved = false; });
  addEventListener('pointermove', e => { if(x0 == null) return; const dx = e.clientX - x0; if(Math.abs(dx) > 4){ moved = true; n.classList.add('drag'); } n.scrollLeft = s0 - dx; });
  addEventListener('pointerup', () => { x0 = null; n.classList.remove('drag'); });
  n.addEventListener('click', e => { if(moved){ e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
})();""")
open(P, 'w', encoding='utf-8').write(s)
print('ok', P)

P = 'public/index.html'
s = open(P, encoding='utf-8').read()


def rep(old, new):
    global s
    assert old in s, old[:90]
    s = s.replace(old, new, 1)


rep("const TABS = [['selec','Sélection du soir'],", "const TABS = [['selec','Sélection du soir'],['btts','Les deux marquent'],")
rep("const views = {selec, soiree,", "const views = {selec, btts, soiree,")
rep("function selec(){", r"""// ---- Les deux équipes marquent : match entier et chaque période
function btts(){
  const B = D.selection?.btts;
  if(!B || !B.liste?.length) return `<div class="empty">Disponible après la prochaine analyse. Appuie sur « Lancer PRÉ-MATCH ».</div>`;
  const bil = b => !b || !b.n ? '' : `<p class="lead">Bilan depuis le lancement : <b>${b.gagnes}/${b.n} gagnés (${pct(b.gagnes/b.n)})</b>.</p>`;
  const S = D.selection.bilan || {};
  const card = (c, id, titre, sous) => !c ? `<div class="empty">Aucun match à venir ce soir.</div>` : `<article class="pick" style="border-color:var(--good)"><div class="top"><div class="who"><b>${esc(c.match)}</b> <span class="sub">${esc(sous)}</span></div><span class="big">${pct(c.prob)}</span></div>
    <div class="chips"><span class="chip good">${esc(titre)}</span><span class="chip">Cote juste ${c.cote_juste}</span><span class="chip">Jouable à partir de ${c.cote_min}</span></div>
    <ul>${c.raisons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>
    <label class="sub">Cote Winamax <input inputmode="decimal" data-btts="${id}" data-p="${c.prob}" placeholder="ex. ${c.cote_min}"></label><div class="res sub" id="btts-res-${id}"></div></article>`;
  const cell = (x, k) => { const p = x.p[k]; const top = k && k===x.meilleure; return [`<b style="${top?'color:var(--good)':''}">${pct(p)}</b><br><span class="sub">cote ${ (1/p).toFixed(2) }</span>`, p]; };
  const rows = table([
    ['Match', x => [`<b>${esc(x.match)}</b><br><span class="sub">${x.heure?esc(x.heure)+' · ':''}buts attendus ${x.xg_ext}–${x.xg_dom}${x.commence?' · commencé':''}</span>`, x.match]],
    ['Match entier', x => cell(x,0), 1], ['1re', x => cell(x,1), 1], ['2e', x => cell(x,2), 1], ['3e', x => cell(x,3), 1],
    ['Période la plus sûre', x => [['','1re','2e','3e'][x.meilleure], x.meilleure]],
  ], B.liste);
  const f = (B.fiab||[]).filter(x=>x.n);
  const bt = B.backtest;
  return `<div class="section">
    <div class="method"><p><b>Comment je calcule.</b> Pour chaque équipe, je pars de ses buts attendus dans ce match (mon modèle mêlé à la cote du total). Je les répartis par période selon ce qu'on observe en NHL : 29 % des buts en 1re période, 35 % en 2e, 36 % en 3e. J'en déduis la chance que chacune marque au moins une fois.</p>
    <p>Le hasard pur sous-estime « les deux marquent » : l'équipe menée pousse, puis sort son gardien. J'ai donc recalé les probabilités sur les vrais scores nhl.com, période par période. Le recalage se met à jour chaque nuit avec les nouveaux matchs. Tout est en <b>temps réglementaire</b> (60 minutes, prolongation non comptée) : vérifie que le pari Winamax a le même libellé.</p>
    <p><b>À savoir.</b> Sur un match entier, les deux équipes marquent environ 93 % du temps, et les écarts entre matchs sont faibles : la cote est donc souvent très basse. Par période, c'est 36 à 43 %, avec de vraies différences, et la 3e période ressort presque toujours. Test sur ${bt.soirees} soirées : le match le plus sûr a gagné ${bt.match[0]} fois sur ${bt.match[1]}, la période la plus sûre ${bt.periode[0]} fois sur ${bt.periode[1]} (prévu ${pct(bt.prevu_periode)}). Une période ne vaut donc le coup que si la cote dépasse la « cote jouable ».</p></div>
    <h2>Match le plus sûr</h2>${bil(S.btts_match)}
    ${card(B.match, 'm', 'Les deux marquent', 'match entier, 60 minutes')}
    <h2>Période la plus sûre</h2>${bil(S.btts_periode)}
    ${card(B.periode, 'p', 'Les deux marquent', B.periode ? B.periode.label : '')}
    <h2>Tous les matchs, période par période</h2>
    <p class="lead">En vert, la période la plus sûre de chaque match. « Cote » = cote juste (sans marge) : joue seulement si Winamax propose au moins 5 % de plus.</p>
    ${rows}
    ${f.length?`<h2>Fiabilité mesurée</h2><p class="lead">Ce que j'avais annoncé en moyenne contre ce qui s'est vraiment passé, sur ${f[0].n} matchs notés :</p><ul>${f.map(x=>`<li>${esc(x.label)} : annoncé ${pct(x.prevu)}, réel ${pct(x.reel)}</li>`).join('')}</ul>`:''}
  </div>`;
}
document.addEventListener('input', e => {
  const id = e.target.dataset.btts; if(id===undefined) return;
  const p = +e.target.dataset.p, c = num(e.target.value), out = $('#btts-res-'+id); if(!c){ out.innerHTML=''; return; }
  const ev = p*c-1;
  out.innerHTML = (ev >= 0.05 ? `<span class="chip good">Valeur : +${(ev*100).toFixed(0)} %</span>` : ev <= -0.05 ? `<span class="chip bad">Cote trop basse (${(ev*100).toFixed(0)} %)</span>` : `<span class="chip">À peu près juste (${ev>=0?'+':''}${(ev*100).toFixed(0)} %)</span>`) + (ev>0 ? kellyTxt(p, c) : '');
});

function selec(){""")
open(P, 'w', encoding='utf-8').write(s)
print('ok')

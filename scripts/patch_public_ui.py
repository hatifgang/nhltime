p='scripts/europe_page_script.js'
s=open(p,encoding='utf8').read()
old_script=s.strip()
rep=[
("const TABS = [['paris','Paris à plus de 50 %'],['matchs','Matchs']",
 "const TABS = [['paris','Paris à plus de 50 %'],['public','Les plus joués'],['matchs','Matchs']"),
("function paris(){",
"""const bookChip = x => x.cote_book ? (x.valeur >= 0.05 ? `<span class="chip good">Bookmakers ${x.cote_book} · bonne cote (+${Math.round(x.valeur*100)} %)</span>` : x.valeur >= 0 ? `<span class="chip">Bookmakers ${x.cote_book} · cote juste (+${Math.round(x.valeur*100)} %)</span>` : `<span class="chip bad">Bookmakers ${x.cote_book} · trop basse (${Math.round(x.valeur*100)} %)</span>`) : '';
const voteBar = (v, dom, ext) => `<div class="bar"><span class="a" style="width:${v.dom*100}%">${pct(v.dom)}</span><span style="width:${v.nul*100}%;background:var(--line);color:var(--fg)">${v.nul>=0.08?'nul':''}</span><span class="h" style="width:${v.ext*100}%">${pct(v.ext)}</span></div><div class="sub" style="display:flex;justify-content:space-between"><span>${esc(dom)}</span><span>${esc(ext)}</span></div>`;
function publicView(){
  const L = (D.public||[]).filter(inLg), C = (D.contre||[]).filter(inLg), B = D.bilan.public || {};
  const g = b => b ? `${b.gagnes}/${b.n} gagnés, ${b.unites > 0 ? '+' : ''}${b.unites} unités (rendement ${b.rendement > 0 ? '+' : ''}${Math.round(b.rendement*100)} %)` : 'pas encore de pari noté';
  return `<div class="section"><div class="method"><p><b>Ce que jouent les autres parieurs.</b> Pour chaque match KHL, le vote des internautes de sports.ru (« Qui va gagner ? »). Je prends le camp choisi par la majorité (au moins 10 votes) et je garde son pari le plus rentable <b>à plus de 50 % de chances</b> : gagne en 60 min, ou « ou nul ».</p>
    <p><b>La cote.</b> C'est la cote médiane des bookmakers affichés sur la page sports.ru (FONBET, Winline, Betcity…). <b>Bonne cote</b> = elle rapporte au moins 5 % de plus que mes chances ne le demandent. SHL et Liiga : aucun site ne publie de votes ou de pronos en nombre suffisant.</p></div>
    <div class="summary">Suivi des choix du public : ${g(B.tous)}. Seulement ceux à bonne cote : ${g(B.bonne_cote)}. Mes propres paris joués à la cote des bookmakers : ${g(B.mes_paris_a_la_cote)}.</div>
    <h2>Les plus joués, du meilleur rapport au moins bon</h2>
    ${L.length?`<div class="picks">${L.map((x,i)=>`<article class="pick"><div class="top"><span class="rank">${i+1}</span><div class="who"><b>${esc(x.label)}</b> <span class="sub">${esc(x.lg)} · ${esc(x.match)} · ${esc(x.heure)}</span></div><span class="big">${pct(x.prob)}</span></div>
      <div class="sub" style="margin:6px 0 2px">${Math.round(x.part*100)} % des ${x.votes} votants choisissent ${esc(x.equipe)}</div>${voteBar(x.vote, x.match.split(' – ')[0], x.match.split(' – ')[1])}
      <div class="chips">${bookChip(x)}<span class="chip">Cote juste ${x.cote_juste}</span><span class="chip good">Jouable dès ${x.cote_min}</span></div>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-cp="${x.prob}" placeholder="ex. ${x.cote_min}"></label><div class="res sub"></div></div></article>`).join('')}</div>`:'<div class="empty">Pas de vote du public disponible pour les matchs d’aujourd’hui et de demain.</div>'}
    ${C.length?`<h2>Le public contre les chiffres (à éviter)</h2><p class="lead">Le public choisit ce camp, mais aucun de ses paris ne dépasse 50 % de chances selon mes calculs.</p>${table([['Match',x=>[`${esc(x.match)}<br><span class="sub">${esc(x.lg)} · ${esc(x.heure)}</span>`,x.utc]],['Choix du public',x=>[`${esc(x.equipe)} (${Math.round(x.part*100)} % de ${x.votes} votes)`,x.part],1],['Mes chances de victoire en 60 min',x=>[P(x.prob_victoire),x.prob_victoire],1],['Cote bookmakers',x=>[x.cote??'—',x.cote],1]], C)}`:''}
    ${(D.historique_public||[]).length?`<h2>Choix du public déjà notés</h2>${table([['Date',p=>[esc(p.date),p.date]],['Match',p=>[esc(p.match),p.match]],['Pari',p=>[esc(p.label),p.label]],['Chances',p=>[pct(p.prob),p.prob],1],['Cote',p=>[p.cote??'—',p.cote],1],['Score',p=>[esc(p.score||''),0]],['Résultat',p=>[p.resultat===1?'<span class="chip good">Gagné</span>':p.resultat===0?'<span class="chip bad">Perdu</span>':'<span class="chip">Annulé</span>',p.resultat]]], D.historique_public.filter(inLg))}`:''}</div>`;
}
function paris(){"""),
("""      <div class="chips"><span class="chip">Cote juste ${x.cote_juste}</span><span class="chip good">Jouable dès ${x.cote_min}</span></div>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-cp="${x.prob}" placeholder="ex. ${x.cote_min}"></label><div class="res sub"></div></div></article>`).join('')}</div>`:'<div class="empty">Aucun match prévu aujourd’hui ni demain dans ces championnats.</div>'}""",
"""      <div class="chips">${bookChip(x)}<span class="chip">Cote juste ${x.cote_juste}</span><span class="chip good">Jouable dès ${x.cote_min}</span></div>
      <div class="wmx"><label>Cote Winamax<input inputmode="decimal" data-cp="${x.prob}" placeholder="ex. ${x.cote_min}"></label><div class="res sub"></div></div></article>`).join('')}</div>`:'<div class="empty">Aucun match prévu aujourd’hui ni demain dans ces championnats.</div>'}"""),
("""['Jouable dès',x=>[`<b>${x.cote_min}</b>`,x.cote_min],1]], L):''}</div>`;""",
"""['Jouable dès',x=>[`<b>${x.cote_min}</b>`,x.cote_min],1],['Cote bookmakers',x=>[x.cote_book?`${x.cote_book} <span class="chip ${x.valeur>=0.05?'good':x.valeur<0?'bad':''}">${x.valeur>0?'+':''}${Math.round(x.valeur*100)} %</span>`:'—',x.valeur??-9],1]], L):''}</div>`;"""),
("""    <ul class="logic">${m.why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>""",
"""    ${m.public?`<div class="sub" style="margin-top:8px">Vote du public (${m.public.votes} votes)</div>${voteBar(m.public.vote, m.dom, m.ext)}`:''}
    <ul class="logic">${m.why.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>"""),
("""['Jouable dès',x=>[x.cote_min,x.cote_min],1]], m.paris)""",
"""['Jouable dès',x=>[x.cote_min,x.cote_min],1],['Bookmakers',x=>[x.cote_book??'—',x.cote_book],1]], m.paris)"""),
("const views = {paris, matchs, classements, bilan, methode};", "const views = {paris, public: publicView, matchs, classements, bilan, methode};"),
("""  add('Historique', D.historique""", """  add('Plus joués', (D.public||[]).map(x=>({ligue:x.lg, match:x.match, heure:x.heure, choix_public:x.equipe, part_votes:x.part, votes:x.votes, pari:x.label, chances:x.prob, cote_bookmakers:x.cote_book, valeur:x.valeur, jouable_des:x.cote_min})));
  add('Historique', D.historique"""),
("""jouable_des:x.cote_min})));
  add('Plus""", """jouable_des:x.cote_min, cote_bookmakers:x.cote_book, valeur:x.valeur})));
  add('Plus"""),
("""    <p><b>Pas encore couverts.</b>""",
"""    <p><b>Les plus joués.</b> Vote « Qui va gagner ? » des internautes de sports.ru et cotes des bookmakers affichées sur la page de chaque match KHL (cote médiane quand plusieurs bookmakers sont affichés, car l'un d'eux affiche parfois une cote périmée). Je suis ces choix à part, à la cote du bookmaker, pour mesurer s'ils rapportent vraiment.</p>
    <p><b>Pas encore couverts.</b>"""),
("Sources : sports.ru (KHL), shl.se (SHL), liiga.fi (Liiga).", "Sources : sports.ru (KHL, votes et cotes), shl.se (SHL), liiga.fi (Liiga)."),
]
for a,b in rep:
    assert a in s, a[:80]
    s=s.replace(a,b,1)
open(p,'w',encoding='utf8').write(s)
h=open('public/hockey.html',encoding='utf8').read()
assert old_script in h
h=h.replace(old_script, s.strip())
open('public/hockey.html','w',encoding='utf8').write(h)
print('ok')

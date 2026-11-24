// NHL Time : comptes (Supabase), accès VIP par catégorie, prix des formules.
// config.js (créé à la mise en ligne) définit window.NT_CONFIG = { url, anon, paiement }. Sans config : mode public (données ouvertes).
window.NT = (() => {
  const C = window.NT_CONFIG || {};
  const sb = C.url && C.anon && window.supabase ? window.supabase.createClient(C.url, C.anon) : null;
  const CATS = [
    { id: 'nhl', nom: 'Hockey', detail: 'NHL + KHL, SHL, Liiga', pages: ['nhl.html', 'hockey.html'] },
    { id: 'nba', nom: 'Basket', detail: 'NBA', pages: ['nba.html'] },
    { id: 'foot', nom: 'Foot', detail: 'Ligue 1, Premier League, Liga, Serie A, Bundesliga, Saudi, coupes d’Europe', pages: ['foot.html'] },
    { id: 'tennis', nom: 'Tennis', detail: 'ATP et WTA', pages: ['tennis.html'] },
    { id: 'paris_du_jour', nom: 'Paris du jour', detail: 'Combinés tous sports à cote 2, recherche web par match', pages: ['mix.html'] },
  ];
  /** 15 € la première catégorie, +5 € chaque catégorie en plus, +10 € pour le foot en plus (même calcul que la base). */
  const PRIX = cats => {
    if (!cats.length) return 0;
    if (cats.length === 1) return 15;
    return 15 + cats.reduce((t, c) => t + (c === 'foot' ? 10 : 5), 0) - 5;
  };
  const BLOCKED = Symbol('bloqué');
  async function user() { if (!sb) return null; const { data } = await sb.auth.getUser(); return data?.user || null; }
  async function profile() { const u = await user(); if (!u) return null; const { data } = await sb.from('profiles').select('*').eq('id', u.id).maybeSingle(); return data; }
  async function subs() { const u = await user(); if (!u) return []; const { data } = await sb.from('subscriptions').select('*').eq('user_id', u.id).order('created_at', { ascending: false }); return data || []; }
  /** Catégories ouvertes pour l'utilisateur connecté (toutes si admin). */
  async function access() {
    const p = await profile(); if (!p) return { user: null, cats: new Set(), admin: false };
    if (p.is_admin) return { user: p, cats: new Set(CATS.map(c => c.id)), admin: true };
    const now = Date.now(), cats = new Set();
    for (const s of await subs()) if (s.statut === 'actif' && Date.parse(s.debut) <= now && now <= Date.parse(s.fin)) s.categories.forEach(c => cats.add(c));
    return { user: p, cats, admin: false };
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function paywall(cat, connected) {
    const c = CATS.find(x => x.id === cat);
    const el = document.querySelector('#panels') || document.body;
    el.innerHTML = `<div style="max-width:560px;margin:30px auto;padding:22px;border:1px solid var(--line,#ccc);border-radius:12px;background:var(--surface,#fff);text-align:center">
      <div style="font-size:2rem">🔒</div><h2 style="margin:6px 0">Pronostics ${esc(c?.nom || '')} réservés aux abonnés VIP</h2>
      <p>${esc(c?.detail || '')} : tous les pronostics du jour, les probabilités, les cotes à jouer et l’analyse de chaque match.</p>
      <p><b>Dès 15 € par mois</b> · +5 € par catégorie en plus (+10 € pour le foot)</p>
      <a href="compte.html${connected ? '#formules' : ''}" style="display:inline-block;margin-top:8px;padding:10px 18px;border-radius:8px;background:var(--accent,#1d4e89);color:#fff;text-decoration:none;font-weight:600">${connected ? 'Choisir ma formule' : 'Créer un compte / se connecter'}</a>
      <p style="font-size:.85rem;opacity:.75;margin-top:14px">Les scores en direct restent gratuits sur l’<a href="./">accueil</a>.</p></div>`;
  }
  /** Données d'une page : VIP (Supabase) si configuré, sinon fichier public. Renvoie BLOCKED si l'accès est refusé. */
  async function page(cat, key, publicUrl) {
    if (!sb) { try { return await (await fetch(publicUrl + '?t=' + Date.now(), { cache: 'no-store' })).json(); } catch (e) { return null; } }
    const a = await access();
    if (!a.cats.has(cat)) { paywall(cat, !!a.user); return BLOCKED; }
    const { data, error } = await sb.from('vip_content').select('contenu').eq('categorie', cat).eq('cle', key).maybeSingle();
    if (error) { console.error(error); return null; }
    return data?.contenu || null;
  }
  return { sb, C, CATS, PRIX, BLOCKED, user, profile, subs, access, page, paywall, esc };
})();

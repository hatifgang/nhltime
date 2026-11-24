// Tes moyens de paiement : remplis les liens et adresses (ils sont affichés aux abonnés au moment de payer).
window.NT_PAIEMENT = {
  paypal: '',     // ex. https://paypal.me/tonpseudo
  revolut: '',    // ex. https://revolut.me/tonpseudo
  crypto: [       // adresses de réception
    { reseau: 'USDT (TRC20)', adresse: '' },
    { reseau: 'Bitcoin (BTC)', adresse: '' },
  ],
  delai: 'sous 24 h',   // délai de validation affiché
};

/* Gestionale CaraMelle — copia verbatim dello script che girava dentro
   Apps Script. Rispetto a quella versione cambiano DUE righe soltanto,
   segnate qui sotto: la configurazione e il logo non li inietta piu'
   Google mentre costruisce la pagina, li ha gia' chiesti il guscio.
   Tutto il resto — carrello, prezzi, IVA, coda offline, scontrini,
   fatture, stampa termica — e' identico riga per riga. */

// Config unica iniettata dal server (prezzi + commissioni). Fonte: getConfigVendite() in Code.gs.
var CONFIG = window.__CONFIG__;      // <-- prima: iniettata da Apps Script

// Logo: lo stesso PNG che va sulla fattura, da fattura_logo.gs. Lo si applica
// da qui invece di scriverlo dentro l'attributo src nell'HTML, perché lì
// HtmlService non lo lasciava passare e restava il testo alternativo.
/* ═══════════════════════════════════════════════════════════
   BANDIERINA SCONTRINO

   Verde: i documenti fiscali si emettono come sempre — scontrino Datacash
   per i Privati, fattura elettronica per i Negozi.

   Rosso: la vendita si registra sul foglio e basta, in ENTRAMBI i rami.
   Niente scontrino, niente fattura, nessun numero bruciato. Sui Negozi
   sparisce anche il campo del numero fattura: chiederlo per un documento
   che non verrà emesso serve solo a far sbagliare.

   Lo stato sta in localStorage, come la coda delle vendite e le fatture in
   attesa: le altre due bandierine non persistono niente — Online rispecchia
   la connessione, Backup è un pulsante senza stato — quindi non c'era un
   meccanismo da imitare, e si usa quello di casa.

   Il verde è il valore di partenza: una chiave assente vale "acceso", mai
   "spento". Vale anche se localStorage è inaccessibile.
   ═══════════════════════════════════════════════════════════ */

var FISCALITA_CHIAVE = 'caramelle_fiscalita_attiva';

function fiscalitaAttiva() {
  try { return localStorage.getItem(FISCALITA_CHIAVE) !== 'no'; }
  catch (e) { return true; }
}

function disegnaFiscalitaToggle() {
  var el = document.getElementById('fiscalitaToggle');
  if (!el) return;
  var acceso = fiscalitaAttiva();
  el.className = 'fiscalita-toggle ' + (acceso ? 'attivo' : 'spento');
  el.querySelector('.status-text').textContent = acceso ? 'Fiscalità' : 'Fiscalità OFF';
  el.title = acceso
    ? 'Scontrini e fatture vengono emessi. Tocca per sospenderli.'
    : 'FISCALITÀ SOSPESA: le vendite si registrano soltanto. Nessuno scontrino ai privati, nessuna fattura ai negozi. Tocca per riattivarla.';
  el.setAttribute('aria-pressed', acceso ? 'false' : 'true');
  aggiornaCampiFattura();
}

/* Numero e scadenza si chiedono solo se una fattura verrà davvero emessa.
   A fiscalità spenta spariscono entrambi: lasciarli lì, col numero già
   compilato e una scadenza selezionata, è un invito a credere che la fattura
   sia partita.
   La spedizione invece RESTA: quella non è un dato della fattura, entra nei
   totali del registro e va battuta comunque. */
function aggiornaCampiFattura() {
  var acceso = fiscalitaAttiva();
  var riga = document.getElementById('rigaNumeroFattura');
  if (riga) riga.style.display = acceso ? 'flex' : 'none';
  var scad = document.getElementById('bloccoScadenza');
  if (scad) scad.style.display = acceso ? 'block' : 'none';
}

function commutaFiscalita() {
  var nuovo = !fiscalitaAttiva();
  try { localStorage.setItem(FISCALITA_CHIAVE, nuovo ? 'si' : 'no'); } catch (e) {}
  disegnaFiscalitaToggle();
  // Nessuna notifica: la pillola cambia colore e scritta sotto il dito, dirlo
  // una seconda volta in una pillola gemella è solo rumore.
}

(function () {
  var avvia = function () {
    var el = document.getElementById('fiscalitaToggle');
    if (!el) return;
    el.addEventListener('click', commutaFiscalita);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commutaFiscalita(); }
    });
    disegnaFiscalitaToggle();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avvia);
  else avvia();
})();

var LOGO_B64 = window.__LOGO__ || ""; // <-- prima: iniettata da Apps Script
(function () {
  var metti = function () {
    var img = document.getElementById('logoCaraMelle');
    if (img && LOGO_B64) img.src = 'data:image/png;base64,' + LOGO_B64;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', metti);
  else metti();
})();
var tipoVendita = "";
var catalogoConfezionati = {};
var metodoPagamentoSelezionato = null;
var modalitaInput = "peso";

var prodottiSelezionati = {
confezionati: [],
sfusi: []
};

var prezziConfezionati = CONFIG.confezionati;   // { Privati:[{nome,prezzo},...], Negozi:[...] }
var prezziKgPrivati    = CONFIG.kg.Privati;
var prezziKgNegozi     = CONFIG.kg.Negozi;
var prezziEttoPrivati  = CONFIG.etto.Privati;
var prezziEttoNegozi   = CONFIG.etto.Negozi;
var COMMISSIONI        = CONFIG.commissioni;
var IVA_PRODOTTO       = CONFIG.iva || {};   // aliquote dal Foglio, per prodotto

// Aliquota di un prodotto. 0 se il Foglio non l'ha data: il totale esce
// visibilmente basso e il server rifiuta la vendita, invece di far passare
// un 10% inventato.
function aliquotaDi(nome) {
  var a = IVA_PRODOTTO[nome];
  return typeof a === 'number' ? a : 0;
}

/* ═══ SPESE DI SPEDIZIONE (solo Negozi) ═══
   Quello che si digita è già l'imponibile della riga in fattura: è il costo
   vero della spedizione, IVA di Packlink compresa, perché quella non si
   detrae. Qui non si scorpora niente, si aggiunge solo l'IVA della merce.
   Il conto lo rifà il server: questo serve al totale sul tablet e alla nota. */
var IVA_SPEDIZIONE = (typeof CONFIG.ivaSpedizione === 'number') ? CONFIG.ivaSpedizione : null;

function spedizioneScelta(aliquotaMerce) {
  var el = document.getElementById('speseSpedizione');
  if (!el || tipoVendita !== 'Negozi') return { imponibile: 0, aliquota: 0, lordo: 0 };
  var v = parseFloat(String(el.value).replace(',', '.'));
  if (isNaN(v) || v <= 0) return { imponibile: 0, aliquota: 0, lordo: 0 };
  var a = IVA_SPEDIZIONE !== null ? IVA_SPEDIZIONE
        : (typeof aliquotaMerce === 'number' ? aliquotaMerce : 10);
  var imp = Math.round(v * 100) / 100;
  return { imponibile: imp, aliquota: a, lordo: Math.round(imp * (1 + a / 100) * 100) / 100 };
}

/* L'aliquota su cui pesa di più il carrello: le spese accessorie seguono
   quella, come l'art. 12 vuole. */
function aliquotaPrevalente(perAliquota) {
  var vinc = null, max = -1;
  Object.keys(perAliquota || {}).forEach(function (a) {
    if (perAliquota[a] > max) { max = perAliquota[a]; vinc = Number(a); }
  });
  return vinc;
}

/* La riga sotto il campo: fa vedere il conto già fatto, così non serve
   moltiplicare a mente né chiedersi se il numero era lordo o netto. */
function aggiornaNotaSpedizione(sped) {
  var nota = document.getElementById('speseSpedizioneNota');
  if (!nota) return;
  // A campo vuoto la nota resta vuota: prima c'era un "quello che hai pagato
  // al corriere" fisso, che occupava una riga per non dire niente. Il conto
  // compare quando c'è un conto da fare.
  if (!sped || sped.imponibile <= 0) {
    nota.textContent = '';
    return;
  }
  var e = function (n) { return n.toFixed(2).replace('.', ','); };
  nota.textContent = 'in fattura: ' + e(sped.imponibile) + ' + IVA ' + sped.aliquota +
                     '% = ' + e(sped.lordo) + ' €';
  nota.style.color = '#b26a00';
}
// Gli sfusi disponibili dipendono dalla fascia, come i confezionati: un
// prodotto senza prezzo al kg per quella fascia non si può battere.
// Prima era una lista sola, presa dai Privati, e in Horeca sarebbe comparso
// anche un prodotto con il solo prezzo al pubblico.
function sfusiDisponibili() {
  var mappa = tipoVendita === "Privati" ? prezziKgPrivati : prezziKgNegozi;
  return Object.keys(mappa || {});
}

function toggleInputMode() {
var toggle = document.getElementById("togglePesoImporto");
modalitaInput = toggle.checked ? "importo" : "peso";
renderSfusoConModalita();
aggiornaTotali();
}

var SistemaOffline = (function() {
function SistemaOffline() {
this.coda = [];
this.intervalloCoda = null;
this.tentativiInvio = {};
this.venditeNonBackuppate = 0;
this.backupInCorso = false;
this.ultimoBackup = null;

var self = this;
setInterval(function() { self.verificaConnessione(); }, 10000);
setInterval(function() { self.sincronizzaCoda(); }, 30000);
setInterval(function() { self.backupAutomatico(); }, 20 * 60 * 1000);

this.aggiornaIndicatoreConnessione(navigator.onLine);
this.aggiungiPulsanteBackup();

this.caricaCodaLocale();          // recupera eventuali vendite non sincronizzate
this.aggiornaBadgeCoda();
if (navigator.onLine) { this.sincronizzaCoda(); }
}

SistemaOffline.prototype.aggiungiVendita = function(dati) {
var vendita = Object.assign({}, dati, {
id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
timestamp: new Date().toISOString(),
stato: 'in_attesa',
tentativi: 0
});

this.coda.push(vendita);
this.venditeNonBackuppate++;
this.aggiornaBadgeCoda();

if (this.venditeNonBackuppate >= 2 && !navigator.onLine) {
this.backupSuDrive();
}

if (navigator.onLine) {
this.inviaVendita(vendita);
} else {
this.mostraNotifica('Vendita salvata - sarà inviata quando torna la connessione', 3000, 'warning');
}

return vendita.id;
};

SistemaOffline.prototype.inviaVendita = function(vendita) {
if (vendita.stato === 'inviando') return;

vendita.stato = 'inviando';
vendita.tentativi = (vendita.tentativi || 0) + 1;
this.aggiornaBadgeCoda();

var self = this;
return new Promise(function(resolve, reject) {
var timeout = setTimeout(function() {
vendita.stato = 'errore';
self.aggiornaBadgeCoda();
reject(new Error('Timeout'));
}, 120000);

google.script.run
.withSuccessHandler(function(risposta) {
clearTimeout(timeout);
self.coda = self.coda.filter(function(v) { return v.id !== vendita.id; });
self.aggiornaBadgeCoda();

// AVVISO FISCALE: vendita salvata ma scontrino non emesso -> l'operatrice deve saperlo.
if (risposta && risposta.scontrino && risposta.scontrino.success === false && !risposta.scontrino.nonApplicabile) {
console.error('Scontrino NON emesso:', risposta.scontrino.errore);
try { alert('ATTENZIONE\n\nLa vendita è stata REGISTRATA ma lo SCONTRINO FISCALE NON è stato emesso.\n\nMotivo: ' + (risposta.scontrino.errore || 'errore') + '\n\nEmetti lo scontrino manualmente / verifica prima di continuare.'); } catch (e) {}
}

// STAMPA SU CARTA: il server manda `stampa` solo per i Privati e solo se lo
// scontrino fiscale è stato davvero emesso. Da qui in poi è tutto in più:
// se la stampantina non c'è, è spenta o si pianta, la vendita è registrata e
// lo scontrino è emesso lo stesso — esce solo un avviso che se ne va da solo.
if (risposta && risposta.stampa && window.stampante) {
  try { window.stampante.stampa(risposta.stampa); } catch (e) { console.error('Stampa scontrino:', e); }
}

// AVVISO PREZZI: il totale mostrato non coincide con quello registrato dal server.
if (risposta && risposta.avvisoPrezzi) {
console.error('Divergenza prezzi:', risposta.avvisoPrezzi);
try { alert('ATTENZIONE PREZZI\n\nIl totale mostrato (EUR ' + risposta.avvisoPrezzi.mostrato.toFixed(2) + ') NON coincide con quello registrato (EUR ' + risposta.avvisoPrezzi.certificato.toFixed(2) + ').\n\nProbabile listino disallineato tra tablet e server, o prodotto fuori catalogo. Verifica i prezzi.'); } catch (e) {}
}

// FATTURA: l'XML lo salva il server su Drive, nella cartella Fatture, insieme
// al PDF — e il link finisce nella colonna XML del registro. Dal tablet non si
// scarica più niente: la fattura si carica su Aruba dal computer, prendendola
// da Drive, che è dove serve.
//
// La pillola «Scarica» resta, ma solo come rete: compare SE Drive non ha preso
// il file (xmlUrl assente). In quel caso il numero di fattura è già bruciato e
// l'XML esiste solo nella risposta, quindi va messo in salvo subito — è l'unico
// punto del gestionale che potrebbe perdere dati in silenzio, e non lo lasciamo
// scoperto. Nel caso normale il tablet non custodisce nulla.
if (risposta && risposta.fattura) {
  if (risposta.fattura.success) {
    if (!risposta.fattura.xmlUrl) {
      console.error('XML non su Drive:', risposta.fattura.xmlErrore || 'motivo non riportato');
      fatturaInAttesa(risposta.fattura);
      try {
        alert('ATTENZIONE — XML NON SALVATO SU DRIVE\n\n' +
              'La fattura ' + risposta.fattura.numero + ' è stata emessa e il numero è bruciato, ' +
              'ma il file XML non è arrivato nella cartella Fatture.\n\n' +
              'A destra è comparsa la pillola «Scarica»: premila per salvarlo sul tablet, ' +
              'altrimenti quel file non esiste da nessuna parte.');
      } catch (e) {}
    }
    if (typeof caricaNumeroSuggerito === 'function') caricaNumeroSuggerito();
  } else {
    console.error('Fattura non generata:', risposta.fattura.errore);
    try { alert('FATTURA NON GENERATA\n\nLa vendita è registrata, ma il file XML non è stato prodotto.\n\nMotivo: ' + risposta.fattura.errore + '\n\nSi può rigenerare dopo aver sistemato i dati.'); } catch (e) {}
  }
}

self.mostraNotifica('Vendita sincronizzata', 2000, 'success');
resolve(risposta);
})
.withFailureHandler(function(errore) {
clearTimeout(timeout);
vendita.stato = 'errore';
vendita.errore = errore.toString();

if (vendita.tentativi < 5) {
var delay = Math.min(5000 * Math.pow(2, vendita.tentativi - 1), 60000);
setTimeout(function() {
vendita.stato = 'in_attesa';
self.inviaVendita(vendita);
}, delay);
self.mostraNotifica('Riprovo tra ' + (delay/1000) + 's...', 2000, 'warning');
} else {
self.mostraNotifica('Errore invio - riproverò più tardi', 3000, 'error');
}

self.aggiornaBadgeCoda();
reject(errore);
})
.salvaDati(vendita);
});
};

SistemaOffline.prototype.sincronizzaCoda = function() {
if (!navigator.onLine || this.coda.length === 0) return;

var daInviare = this.coda.filter(function(v) { return v.stato !== 'inviando'; });
var self = this;

daInviare.forEach(function(vendita) {
self.inviaVendita(vendita).catch(function(errore) {
console.error('Errore invio vendita:', errore);
});
});
};

SistemaOffline.prototype.verificaConnessione = function() {
var online = navigator.onLine;
this.aggiornaIndicatoreConnessione(online);

if (online && this.coda.length > 0) {
this.sincronizzaCoda();
}
};

SistemaOffline.prototype.aggiornaIndicatoreConnessione = function(online) {
var indicator = document.getElementById('connectionIndicator');
if (online) {
indicator.className = 'connection-indicator online';
indicator.querySelector('.status-text').textContent = 'Online';
} else {
indicator.className = 'connection-indicator offline';
indicator.querySelector('.status-text').textContent = 'Offline';
}
};

SistemaOffline.prototype.aggiornaBadgeCoda = function() {
this.salvaCodaLocale();   // ogni variazione della coda viene persistita subito
var backupBtn = document.getElementById('backupButton');
if (backupBtn) {
var testo = this.coda.length > 0 ? 'Backup (' + this.coda.length + ')' : 'Backup';
backupBtn.querySelector('span:first-child').textContent = testo;
}
};

// Persistenza locale della coda: sopravvive a chiusura/reload della scheda.
SistemaOffline.prototype.salvaCodaLocale = function() {
try { localStorage.setItem('caramelle_coda', JSON.stringify(this.coda)); } catch (e) {}
};

SistemaOffline.prototype.caricaCodaLocale = function() {
try {
var s = localStorage.getItem('caramelle_coda');
this.coda = s ? (JSON.parse(s) || []) : [];
// una vendita rimasta 'inviando' da una sessione interrotta va ri-tentata
this.coda.forEach(function(v) { if (v.stato === 'inviando') v.stato = 'in_attesa'; });
} catch (e) { this.coda = []; }
};

SistemaOffline.prototype.mostraNotifica = function(messaggio, durata, tipo) {
durata = durata || 3000;
tipo = tipo || 'info';
  
var notificheEsistenti = document.querySelectorAll('.offline-notification');
notificheEsistenti.forEach(function(n) { n.remove(); });

var notifica = document.createElement('div');
notifica.className = 'offline-notification ' + tipo;
notifica.textContent = messaggio;

if (messaggio.length > 50) {
notifica.textContent = messaggio.substring(0, 47) + '...';
notifica.title = messaggio;
}

document.body.appendChild(notifica);
notifica.offsetHeight;

setTimeout(function() { notifica.classList.add('show'); }, 10);

setTimeout(function() {
notifica.classList.remove('show');
setTimeout(function() { notifica.remove(); }, 300);
}, durata);
};

SistemaOffline.prototype.backupSuDrive = function() {
if (this.backupInCorso || this.coda.length === 0) return;

this.backupInCorso = true;
this.mostraNotifica('Backup in corso...', 2000, 'info');

var self = this;
google.script.run
.withSuccessHandler(function(risultato) {
if (risultato.success) {
self.venditeNonBackuppate = 0;
self.ultimoBackup = new Date();
self.mostraNotifica('Backup completato', 2000, 'success');
self.aggiornaInfoBackup();
} else {
self.mostraNotifica('Errore backup', 3000, 'error');
}
self.backupInCorso = false;
})
.withFailureHandler(function(errore) {
console.error('Errore backup:', errore);
self.mostraNotifica('Errore backup', 3000, 'error');
self.backupInCorso = false;
})
.salvaBackupDrive({
timestamp: new Date().toISOString(),
dispositivo: navigator.userAgent,
vendite: self.coda
});
};

SistemaOffline.prototype.backupAutomatico = function() {
if (this.coda.length > 0) {
this.backupSuDrive();
}
};

SistemaOffline.prototype.aggiungiPulsanteBackup = function() {
var backupBtn = document.createElement('div');
backupBtn.id = 'backupButton';
backupBtn.className = 'backup-button';
backupBtn.innerHTML = '<span>Backup</span><span id="backupInfo" class="backup-info"></span>';
  
var self = this;
backupBtn.onclick = function() { self.menuBackup(); };

document.body.appendChild(backupBtn);
this.aggiornaInfoBackup();
};

SistemaOffline.prototype.aggiornaInfoBackup = function() {
var info = document.getElementById('backupInfo');
if (info && this.ultimoBackup) {
var minuti = Math.floor((new Date() - this.ultimoBackup) / 60000);
info.textContent = minuti > 0 ? '(' + minuti + 'm fa)' : '(ora)';
}
};

SistemaOffline.prototype.menuBackup = function() {
var menu = document.createElement('div');
menu.className = 'backup-menu';

var content = document.createElement('div');
content.className = 'backup-menu-content';

var h3 = document.createElement('h3');
h3.textContent = 'Gestione Backup';
content.appendChild(h3);

var p1 = document.createElement('p');
p1.textContent = 'Vendite in coda: ' + this.coda.length;
content.appendChild(p1);

if (this.ultimoBackup) {
var p2 = document.createElement('p');
p2.textContent = 'Ultimo backup: ' + this.ultimoBackup.toLocaleTimeString();
content.appendChild(p2);
}

var buttonsDiv = document.createElement('div');
buttonsDiv.className = 'backup-menu-buttons';

var btn1 = document.createElement('button');
btn1.textContent = 'Backup Ora';
btn1.onclick = function() {
sistemaOffline.backupSuDrive();
menu.remove();
};
buttonsDiv.appendChild(btn1);

var btn2 = document.createElement('button');
btn2.textContent = 'Recupera Backup';
btn2.onclick = function() {
sistemaOffline.recuperaBackup();
menu.remove();
};
buttonsDiv.appendChild(btn2);

var btn3 = document.createElement('button');
btn3.textContent = 'Emergenza CSV';
btn3.style.background = '#f44336';
btn3.style.color = 'white';
btn3.onclick = function() {
sistemaOffline.exportEmergenzaCSV();
menu.remove();
};
buttonsDiv.appendChild(btn3);

var btn4 = document.createElement('button');
btn4.textContent = 'Chiudi';
btn4.onclick = function() { menu.remove(); };
buttonsDiv.appendChild(btn4);

content.appendChild(buttonsDiv);
menu.appendChild(content);
document.body.appendChild(menu);
};

SistemaOffline.prototype.recuperaBackup = function() {
if (confirm('Vuoi recuperare l\'ultimo backup? Le vendite recuperate verranno aggiunte alla coda attuale.')) {
this.mostraNotifica('Recupero backup...', 2000, 'info');

var self = this;
google.script.run
.withSuccessHandler(function(risultato) {
if (risultato.success && risultato.data) {
var venditeRecuperate = risultato.data.vendite || [];
venditeRecuperate.forEach(function(v) {
if (!self.coda.find(function(esistente) { return esistente.id === v.id; })) {
self.coda.push(v);
}
});
self.aggiornaBadgeCoda();
self.mostraNotifica('Recuperate ' + venditeRecuperate.length + ' vendite', 3000, 'success');
} else {
self.mostraNotifica('Nessun backup trovato', 3000, 'warning');
}
})
.withFailureHandler(function(errore) {
console.error('Errore recupero:', errore);
self.mostraNotifica('Errore recupero backup', 3000, 'error');
})
.recuperaUltimoBackup();
}
};

SistemaOffline.prototype.exportEmergenzaCSV = function() {
if (this.coda.length === 0) {
this.mostraNotifica('Nessuna vendita da esportare', 2000, 'warning');
return;
}

var csv = "Data,Ora,Evento,Cliente,Confezionati,Sfuso,Pagamento,Stato\n";

this.coda.forEach(function(v) {
  var data = new Date(v.timestamp).toLocaleDateString('it-IT');
  var ora = new Date(v.timestamp).toLocaleTimeString('it-IT');
  var evento = v.nomeEvento || '';
  var confezionati = v.confezionati ? v.confezionati.join(' | ') : '';
  var sfusi = v.sfuso ? v.sfuso.map(function(s) { return s.nome + ' ' + s.grammi + 'g'; }).join(' | ') : '';
  csv += data + ',' + ora + ',"' + evento + '","' + v.cliente + '","' + confezionati + '","' + sfusi + '","' + (v.metodoPagamento || '') + '","' + v.stato + '"\n';
});

var ora = new Date().toISOString()
.replace('T', '_')
.replace(/:/g, '-')
.slice(0, 16);

var blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
var link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = 'vendite_emergenza_' + ora + '.csv';
link.click();

this.mostraNotifica('Esportate ' + this.coda.length + ' vendite in CSV', 3000, 'success');
};

return SistemaOffline;
})();

var sistemaOffline;

function iniziaVendita(tipo) {
if (tipo === "Privati") {
iniziaSelezioneProdotti(tipo);
} else {
tipoVendita = tipo;
document.getElementById("sceltaTipoVendita").classList.add("hidden");
document.getElementById("paginaGestionale").classList.remove("hidden");

preparaSchermataVendita();
catalogoConfezionati = prezziConfezionati[tipo];
renderConfezionati();
renderSfuso();
}
}

/* Prepara la schermata di vendita. Serve una funzione sola perché ci si
   arriva da due strade: i Privati passano dalla selezione prodotti, i
   Negozi ci vanno dritti da iniziaVendita. Tenere le due copie allineate
   a mano non ha funzionato: il blocco fattura non compariva sui Negozi. */
function preparaSchermataVendita() {
  // L'etichetta a schermo è "Horeca", il valore interno resta "Negozi":
  // quella stringa è anche il nome del foglio su cui si scrivono le vendite.
  var etichetta = tipoVendita === "Negozi" ? "Horeca" : tipoVendita;
  document.getElementById("titoloVendita").innerText = "Registrazione Vendite (" + etichetta + ")";
  document.getElementById("opzioniCondivisione").style.display = tipoVendita === "Negozi" ? "none" : "block";
  document.getElementById("datiNegozio").style.display = tipoVendita === "Negozi" ? "block" : "none";
  document.getElementById("cliente").placeholder = tipoVendita === "Negozi"
    ? "Nome del negozio" : "Nome / Cognome (opzionale)";
  // Sui Negozi il metodo non si sceglie: si paga a bonifico, immediato o a
  // termine. Lo si fissa invece di nasconderlo e basta, così la colonna
  // "Metodo Pagamento" del registro resta vera invece di restare vuota.
  // Bonifico non è nella tabella commissioni, quindi la commissione è 0.
  var gruppo = document.getElementById("gruppoPagamento");
  if (gruppo) gruppo.style.display = tipoVendita === "Negozi" ? "none" : "block";
  if (tipoVendita === "Negozi") {
    metodoPagamentoSelezionato = "Bonifico";
    document.getElementById("sezioneContanti").style.display = "none";
  }

  if (tipoVendita === "Negozi") { caricaElencoNegozi(); caricaNumeroSuggerito(); }
  // Il campo del numero segue la bandierina anche all'apertura, non solo al tocco.
  if (typeof aggiornaCampiFattura === 'function') aggiornaCampiFattura();
}

function iniziaSelezioneProdotti(tipo) {
tipoVendita = tipo;

document.getElementById("sceltaTipoVendita").classList.add("hidden");
document.getElementById("selezioneProdotti").classList.remove("hidden");

document.getElementById("campoNomeEvento").style.display = "block";

var nomeEventoSalvato = sessionStorage.getItem('nomeEvento');
if (nomeEventoSalvato) {
document.getElementById("nomeEvento").value = nomeEventoSalvato;
}

var prodottiSalvati = sessionStorage.getItem('prodottiSelezionati');
if (prodottiSalvati) {
prodottiSelezionati = JSON.parse(prodottiSalvati);
}

document.getElementById("titoloSelezione").innerHTML = "Seleziona Prodotti Disponibili Oggi";

catalogoConfezionati = prezziConfezionati[tipo];
renderSelezioneProdotti();
}

function renderSelezioneProdotti() {
var contenitoreConf = document.getElementById("selezione-confezionati");
var contenitoreSfusi = document.getElementById("selezione-sfusi");

contenitoreConf.innerHTML = "";
catalogoConfezionati.forEach(function(p, i) {
var item = document.createElement("div");
item.className = "product-selector";
if (prodottiSelezionati.confezionati.includes(p.nome)) {
item.classList.add('selected');
}
item.onclick = function() { toggleProdottoConfezionato(i, p.nome); };

var prezzoText = tipoVendita === "Privati" ?
'€' + p.prezzo.toFixed(2) :
'€' + p.prezzo.toFixed(2) + ' (+IVA)';

item.innerHTML = '<div class="product-selector-name">' + p.nome + '</div><div class="product-selector-price">' + prezzoText + '</div>';

contenitoreConf.appendChild(item);
});

contenitoreSfusi.innerHTML = "";
sfusiDisponibili().forEach(function(nome, i) {
var prezzoKg = tipoVendita === "Privati" ? prezziKgPrivati[nome] : prezziKgNegozi[nome];
var item = document.createElement("div");
item.className = "sfuso-selector";
if (prodottiSelezionati.sfusi.includes(nome)) {
item.classList.add('selected');
}
item.onclick = function() { toggleProdottoSfuso(i, nome); };

var prezzoText = tipoVendita === "Privati" ?
'€' + prezzoKg + '/kg' :
'€' + prezzoKg + '/kg (+IVA)';

item.innerHTML = '<div class="sfuso-selector-name">' + nome + '</div><div class="sfuso-selector-price">' + prezzoText + '</div>';

contenitoreSfusi.appendChild(item);
});

aggiornaContatoreProdotti();
}

function toggleProdottoConfezionato(index, nome) {
var items = document.querySelectorAll('#selezione-confezionati .product-selector');
var item = items[index];

if (prodottiSelezionati.confezionati.includes(nome)) {
prodottiSelezionati.confezionati = prodottiSelezionati.confezionati.filter(function(p) { return p !== nome; });
item.classList.remove('selected');
} else {
prodottiSelezionati.confezionati.push(nome);
item.classList.add('selected');
}

aggiornaContatoreProdotti();
}

function toggleProdottoSfuso(index, nome) {
var items = document.querySelectorAll('#selezione-sfusi .sfuso-selector');
var item = items[index];

if (prodottiSelezionati.sfusi.includes(nome)) {
prodottiSelezionati.sfusi = prodottiSelezionati.sfusi.filter(function(p) { return p !== nome; });
item.classList.remove('selected');
} else {
prodottiSelezionati.sfusi.push(nome);
item.classList.add('selected');
}

aggiornaContatoreProdotti();
}

function aggiornaContatoreProdotti() {
var totale = prodottiSelezionati.confezionati.length + prodottiSelezionati.sfusi.length;
var contatore = document.getElementById("contatoreProdotti");
var btnConferma = document.getElementById("btnConfermaSelez");

if (totale === 0) {
contatore.textContent = "Nessun prodotto selezionato";
btnConferma.disabled = true;
btnConferma.style.background = "#999";
} else {
contatore.textContent = totale + ' prodott' + (totale === 1 ? 'o' : 'i') + ' selezionat' + (totale === 1 ? 'o' : 'i');
btnConferma.disabled = false;
btnConferma.style.background = "#1a1a1a";
}
}

function tornaATipoVendita() {
document.getElementById("selezioneProdotti").classList.add("hidden");
document.getElementById("sceltaTipoVendita").classList.remove("hidden");

prodottiSelezionati = { confezionati: [], sfusi: [] };
document.getElementById("nomeEvento").value = "";
sessionStorage.removeItem('nomeEvento');
sessionStorage.removeItem('prodottiSelezionati');
}

function confermaSelezioneProdotti() {
if (prodottiSelezionati.confezionati.length === 0 && prodottiSelezionati.sfusi.length === 0) {
return;
}

var nomeEvento = document.getElementById("nomeEvento").value.trim();
if (nomeEvento) {
sessionStorage.setItem('nomeEvento', nomeEvento);
} else {
sessionStorage.removeItem('nomeEvento');
}

sessionStorage.setItem('prodottiSelezionati', JSON.stringify(prodottiSelezionati));

document.getElementById("selezioneProdotti").classList.add("hidden");
document.getElementById("paginaGestionale").classList.remove("hidden");

preparaSchermataVendita();

catalogoConfezionati = prezziConfezionati[tipoVendita].filter(function(p) {
return prodottiSelezionati.confezionati.includes(p.nome);
});

renderConfezionati();

var sezioneSfusi = document.querySelector('#paginaGestionale .product-section:has(.accordion)');
if (prodottiSelezionati.sfusi.length > 0) {
sezioneSfusi.style.display = "block";
renderSfusoFiltrato();
} else {
sezioneSfusi.style.display = "none";
}

setTimeout(function() {
window.scrollTo({ top: 0, behavior: 'smooth' });
}, 100);
}

function renderSfusoFiltrato() {
var contenitore = document.getElementById("prodotti-sfuso");
contenitore.innerHTML = "";

var sfusiFiltrati = sfusiDisponibili().filter(function(nome) {
return prodottiSelezionati.sfusi.includes(nome);
});

sfusiFiltrati.forEach(function(nome, i) {
var item = document.createElement("div");
item.className = "sfuso-item";

item.onclick = function(e) {
if (e.target.classList.contains('sfuso-input')) return;
var input = item.querySelector('.sfuso-input');
input.focus();
};

var placeholder = modalitaInput === "peso" ? "grammi" : "€";
var inputId = "sfuso_" + i;

item.innerHTML = '<div class="sfuso-name-price"><div class="sfuso-name">' + nome + '</div></div><div class="sfuso-input-container"><div class="sfuso-calculated" id="' + inputId + '_calc"></div><input type="text" inputmode="decimal" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" class="sfuso-input" id="' + inputId + '" value="" data-nome="' + nome + '" data-sfuso="true" placeholder="' + placeholder + '"></div>';

contenitore.appendChild(item);
  
var inputElement = document.getElementById(inputId);
inputElement.addEventListener('input', function() { validaNumeroEAggiorna(this); });
inputElement.addEventListener('keydown', function(e) {
if (e.key === 'Enter') {
e.preventDefault();
this.blur();
}
});
});
}

function renderSfusoConModalita() {
var inputs = document.querySelectorAll("[id^='sfuso_']");

inputs.forEach(function(input) {
if (input.id.endsWith('_calc')) return;
if (!input.classList || !input.classList.contains('sfuso-input')) return;

var placeholder = modalitaInput === "peso" ? "grammi" : "€";
input.placeholder = placeholder;
input.value = "";
var parent = input.closest('.sfuso-item');
if (parent) {
parent.classList.remove('selected');
}

var calcDisplay = document.getElementById(input.id + '_calc');
if (calcDisplay) {
calcDisplay.textContent = '';
}
});
}

function tornaIndietro() {
if (tipoVendita === "Privati") {
document.getElementById("paginaGestionale").classList.add("hidden");
document.getElementById("selezioneProdotti").classList.remove("hidden");

document.getElementById("campoNomeEvento").style.display = "none";

setTimeout(function() {
window.scrollTo({ top: 0, behavior: 'smooth' });
}, 100);
} else {
document.getElementById("paginaGestionale").classList.add("hidden");
document.getElementById("sceltaTipoVendita").classList.remove("hidden");
// Niente da riaccendere: il vecchio titolo "Confetteria di Valle / Sistema di
// Gestione Vendite" è nascosto via CSS da quando c'è il logo. Qui c'era un
// display:block che vinceva sul CSS e lo faceva ricomparire sopra al logo,
// ma solo tornando da Horeca — dai Privati si passa da un'altra funzione.
}

resetForm();
}

function resetForm() {
document.querySelectorAll("input").forEach(function(input) {
if (input.type === "checkbox") {
input.checked = false;
} else {
input.value = "";
}
});
document.querySelectorAll(".quantity-display").forEach(function(display) {
display.textContent = "0";
display.classList.remove("selected");
});
document.querySelectorAll(".quantity-minus").forEach(function(btn) {
btn.classList.remove("visible");
});
document.querySelectorAll(".product-clickable").forEach(function(btn) {
btn.classList.remove("selected");
});
document.querySelectorAll(".sfuso-item").forEach(function(item) {
item.classList.remove("selected");
});
aggiornaTotali();
calcolaResto();

metodoPagamentoSelezionato = tipoVendita === "Negozi" ? "Bonifico" : null;
document.getElementById("btnContanti").classList.remove('selected');
document.getElementById("btnSatispay").classList.remove('selected');
document.getElementById("btnSumUp").classList.remove('selected');
toggleCalcoloResto();

// Blocco negozio: i campi li ha gia' svuotati il ciclo sugli input qui sopra,
// ma la riga verde e il modulo del negozio nuovo restano a schermo, e —
// soprattutto — l'anagrafica resta in memoria. Va azzerata anche quella, se no
// la vendita successiva parte col negozio precedente gia' agganciato.
if (typeof window.azzeraNegozio === 'function') window.azzeraNegozio();
}

function renderConfezionati() {
var contenitore = document.getElementById("prodotti-confezionati");
contenitore.innerHTML = "";

catalogoConfezionati.forEach(function(p, i) {
var item = document.createElement("div");
item.className = "product-item";

item.innerHTML = '<button class="product-clickable" id="conf_' + i + '_btn"><div class="product-name">' + p.nome + '</div></button><div class="quantity-section"><div class="quantity-display" id="conf_' + i + '_display">0</div><div class="quantity-minus" id="conf_' + i + '_minus">−</div></div><input type="hidden" id="conf_' + i + '" data-nome="' + p.nome + '" data-prezzo="' + p.prezzo + '" value="0">';

contenitore.appendChild(item);
  
var btnConf = document.getElementById('conf_' + i + '_btn');
btnConf.addEventListener('click', function() {
if (clickDaSaltare(this)) return;
aggiungiProdotto('conf_' + i);
});
abilitaTenutoPremuto(btnConf, function () { aggiungiProdotto('conf_' + i); });

var minusConf = document.getElementById('conf_' + i + '_minus');
minusConf.addEventListener('click', function() {
if (clickDaSaltare(this)) return;
rimuoviProdotto('conf_' + i);
});
abilitaTenutoPremuto(minusConf, function () { rimuoviProdotto('conf_' + i); });
});
}

function renderSfuso() {
var contenitore = document.getElementById("prodotti-sfuso");
contenitore.innerHTML = "";

sfusiDisponibili().forEach(function(nome, i) {
var item = document.createElement("div");
item.className = "sfuso-item";

item.onclick = function(e) {
if (e.target.classList.contains('sfuso-input')) return;
var input = item.querySelector('.sfuso-input');
input.focus();
};

var placeholder = modalitaInput === "peso" ? "grammi" : "€";

item.innerHTML = '<div class="sfuso-name-price"><div class="sfuso-name">' + nome + '</div></div><div class="sfuso-input-container"><div class="sfuso-calculated" id="sfuso_' + i + '_calc"></div><input type="text" inputmode="decimal" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" class="sfuso-input" id="sfuso_' + i + '" value="" data-nome="' + nome + '" data-sfuso="true" placeholder="' + placeholder + '"></div>';

contenitore.appendChild(item);
  
var inputElement = document.getElementById('sfuso_' + i);
inputElement.addEventListener('input', function() { validaNumeroEAggiorna(this); });
inputElement.addEventListener('keydown', function(e) {
if (e.key === 'Enter') {
e.preventDefault();
this.blur();
}
});
});
}

/* ═══════════════════════════════════════════════════════════
   TENUTO PREMUTO — solo sui NEGOZI

   Ai mercati si vende un pezzo per volta e il tocco singolo basta. Ai negozi
   invece si caricano venti confezioni dello stesso prodotto, e venti tocchi
   sono venti occasioni di sbagliare il conto. Tenendo premuto il numero sale
   da solo.

   Attivo SOLO con tipoVendita === "Negozi": ai mercati un dito appoggiato un
   attimo di troppo aggiungerebbe merce che nessuno ha comprato, e lì lo
   scontrino è fiscale.

   La partenza è ritardata di 450ms: sotto quella soglia resta un tocco
   normale. Poi accelera — prima lento, per fermarsi sui numeri piccoli, poi
   più svelto quando è chiaro che se ne vogliono tanti.
   ═══════════════════════════════════════════════════════════ */
function abilitaTenutoPremuto(bottone, azione) {
  if (!bottone) return;

  var timerAvvio = null, timerRipeti = null, ripetizioni = 0;

  function passo() {
    ripetizioni++;
    azione();
    // 250ms per i primi quattro, poi 120, poi 60: si può ancora fermarsi
    // sul numero giusto, ma arrivare a venti non è una penitenza.
    var attesa = ripetizioni < 4 ? 250 : (ripetizioni < 12 ? 120 : 60);
    timerRipeti = setTimeout(passo, attesa);
  }

  function avvia(e) {
    if (tipoVendita !== "Negozi") return;
    if (e.button !== undefined && e.button !== 0) return;   // solo tasto sinistro
    ferma();
    timerAvvio = setTimeout(function () { passo(); }, 450);
  }

  function ferma() {
    if (timerAvvio)  { clearTimeout(timerAvvio);  timerAvvio  = null; }
    if (timerRipeti) { clearTimeout(timerRipeti); timerRipeti = null; }
  }

  function rilascia() {
    var haRipetuto = ripetizioni > 0;
    ferma();
    ripetizioni = 0;
    // Dopo il rilascio il browser manda comunque un click: se il numero è già
    // salito da solo, quel click aggiungerebbe un pezzo di troppo. Si segna il
    // bottone e il gestore del click lo salta una volta.
    if (haRipetuto) bottone.dataset.saltaClick = '1';
  }

  if (window.PointerEvent) {
    bottone.addEventListener('pointerdown', avvia);
    bottone.addEventListener('pointerup', rilascia);
    bottone.addEventListener('pointerleave', rilascia);
    bottone.addEventListener('pointercancel', rilascia);
  } else {
    bottone.addEventListener('touchstart', avvia, { passive: true });
    bottone.addEventListener('touchend', rilascia);
    bottone.addEventListener('touchcancel', rilascia);
    bottone.addEventListener('mousedown', avvia);
    bottone.addEventListener('mouseup', rilascia);
    bottone.addEventListener('mouseleave', rilascia);
  }
  // Su iPad il dito fermo apre la lente di ingrandimento e il menù di copia:
  // qui darebbe fastidio e basta.
  bottone.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

/* true se questo click va ignorato perché è la coda di un tenuto premuto. */
function clickDaSaltare(bottone) {
  if (bottone && bottone.dataset.saltaClick === '1') {
    delete bottone.dataset.saltaClick;
    return true;
  }
  return false;
}

function aggiungiProdotto(id) {
var input = document.getElementById(id);
var display = document.getElementById(id + "_display");
var minusBtn = document.getElementById(id + "_minus");
var productBtn = document.getElementById(id + "_btn");

var currentValue = parseInt(input.value) || 0;
var newValue = currentValue + 1;

input.value = newValue;
display.textContent = newValue;

productBtn.classList.add('selected');
display.classList.add('selected');

productBtn.blur();

if (newValue > 0) {
minusBtn.classList.add('visible');
}

aggiornaTotali();
}

function rimuoviProdotto(id) {
var input = document.getElementById(id);
var display = document.getElementById(id + "_display");
var minusBtn = document.getElementById(id + "_minus");
var productBtn = document.getElementById(id + "_btn");

var currentValue = parseInt(input.value) || 0;
var newValue = Math.max(0, currentValue - 1);

input.value = newValue;
display.textContent = newValue;

if (newValue === 0) {
minusBtn.classList.remove('visible');
productBtn.classList.remove('selected');
display.classList.remove('selected');
}

aggiornaTotali();
}

function aggiornaTotali() {
var totaleCalcolato = 0;
var perAliquota = {};                      // stesso conteggio che fa il server
function sommaAliq(nome, importo) {
  var a = aliquotaDi(nome);
  perAliquota[a] = (perAliquota[a] || 0) + importo;
}

document.querySelectorAll("[id^='conf_']").forEach(function(input) {
if (input.type === "hidden") {
var qty = parseInt(input.value) || 0;
var prezzo = parseFloat(input.dataset.prezzo);
totaleCalcolato += qty * prezzo;
if (qty > 0) sommaAliq(input.dataset.nome, qty * prezzo);
}
});

document.querySelectorAll("[id^='sfuso_']").forEach(function(input) {
if (input.id.endsWith('_calc')) return;
if (!input.classList || !input.classList.contains('sfuso-input')) return;

var valore = parseFloat(input.value);
var sfusoItem = input.closest('.sfuso-item');
var calcDisplay = document.getElementById(input.id + '_calc');

if (!isNaN(valore) && valore > 0) {
sfusoItem.classList.add('selected');

var nome = input.dataset.nome;
var prezzoKg = tipoVendita === "Privati" ? prezziKgPrivati[nome] : prezziKgNegozi[nome];

var prezzo = 0;
var grammiEffettivi = 0;

// Il prezzo all'etto della fascia in corso. Se la cella del Foglio è vuota
// non c'è nessun ripiego: prima il server ne inventava uno (7 o 4,30) e il
// tablet no, così i due totali divergevano. Ora nessuno dei due inventa e la
// vendita si ferma, con scritto quale cella riempire.
var prezzoEtto = (tipoVendita === "Privati" ? prezziEttoPrivati : prezziEttoNegozi)[nome];
var ettoBuono  = typeof prezzoEtto === 'number' && isFinite(prezzoEtto) && prezzoEtto > 0;
var kgBuono    = typeof prezzoKg   === 'number' && isFinite(prezzoKg)   && prezzoKg   > 0;

if (modalitaInput === "peso") {
grammiEffettivi = valore;

if (grammiEffettivi >= 1000) {
prezzo = kgBuono ? (grammiEffettivi / 1000) * prezzoKg : 0;
} else {
prezzo = ettoBuono ? (grammiEffettivi / 100) * prezzoEtto : 0;
}

if (calcDisplay) {
calcDisplay.textContent = (grammiEffettivi >= 1000 ? kgBuono : ettoBuono)
  ? '' : 'prezzo mancante nel Foglio';
}

} else {
prezzo = valore;

if (kgBuono && prezzo >= prezzoKg) {
grammiEffettivi = (prezzo / prezzoKg) * 1000;
} else if (ettoBuono) {
grammiEffettivi = (prezzo / prezzoEtto) * 100;
} else {
grammiEffettivi = 0;
}

if (calcDisplay) {
if (!kgBuono && !ettoBuono) {
calcDisplay.textContent = 'prezzo mancante nel Foglio';
} else if (grammiEffettivi >= 1000) {
calcDisplay.textContent = (grammiEffettivi / 1000).toFixed(2) + 'kg';
} else {
calcDisplay.textContent = Math.round(grammiEffettivi) + 'g';
}
}
}

totaleCalcolato += prezzo;
sommaAliq(nome, prezzo);
} else {
sfusoItem.classList.remove('selected');
if (calcDisplay) {
calcDisplay.textContent = '';
}
}
});

var importoPersonalizzato = parseFloat(document.getElementById("personalizzato").value);
var totaleCalcolatoElement = document.getElementById("totaleCalcolato");
var totaleCustomLabelElement = document.getElementById("totaleCustomLabel");
var totaleElement = document.getElementById("totale");

var totaleFinale;

// Lordo sommando ogni aliquota per conto suo: per i Negozi il listino è
// al netto, per i Privati è già IVA inclusa.
var lordoCalcolato = 0;
Object.keys(perAliquota).forEach(function (a) {
  lordoCalcolato += tipoVendita === "Privati"
    ? perAliquota[a]
    : perAliquota[a] * (1 + Number(a) / 100);
});

// La spedizione si somma DOPO l'importo personalizzato, non dentro: lo
// sconto lo si fa sui confetti, non sul corriere.
var sped = spedizioneScelta(aliquotaPrevalente(perAliquota));
aggiornaNotaSpedizione(sped);

if (!isNaN(importoPersonalizzato) && importoPersonalizzato > 0) {
var calcolatoConIva = lordoCalcolato + sped.lordo;

totaleCalcolatoElement.textContent = '€' + calcolatoConIva.toFixed(2).replace('.', ',');
totaleCalcolatoElement.classList.remove('hidden');
totaleCustomLabelElement.classList.remove('hidden');

totaleFinale = importoPersonalizzato + sped.lordo;
} else {
totaleCalcolatoElement.classList.add('hidden');
totaleCustomLabelElement.classList.add('hidden');

totaleFinale = lordoCalcolato + sped.lordo;
}

totaleElement.textContent = '€' + totaleFinale.toFixed(2).replace('.', ',');

calcolaResto();
aggiornaPulsanteDinamico();
}

function validaNumeroEAggiorna(input) {
var value = input.value;
value = value.replace(/[^0-9.]/g, '');

var parts = value.split('.');
if (parts.length > 2) {
value = parts[0] + '.' + parts.slice(1).join('');
}

input.value = value;
aggiornaTotali();
}

function validaNumeroPersonalizzato(input) {
var value = input.value;
value = value.replace(/[^0-9.]/g, '');

var parts = value.split('.');
if (parts.length > 2) {
value = parts[0] + '.' + parts.slice(1).join('');
}

input.value = value;
aggiornaTotali();
}

function validaNumeroBanconota(input) {
var value = input.value;
value = value.replace(/[^0-9.]/g, '');

var parts = value.split('.');
if (parts.length > 2) {
value = parts[0] + '.' + parts.slice(1).join('');
}

input.value = value;
calcolaResto();
}

function validaTelefono(input) {
var value = input.value;
value = value.replace(/[^0-9+() -]/g, '');
input.value = value;
  
var soloNumeri = value.replace(/[^0-9]/g, '');
var whatsappCheckbox = document.getElementById("whatsapp");
  
if (soloNumeri.length >= 9) {
whatsappCheckbox.checked = true;
} else {
whatsappCheckbox.checked = false;
}
  
aggiornaPulsanteDinamico();
}

function togglePagamento(metodo) {
var btnId = 'btn' + metodo.replace(' ', '');
var button = document.getElementById(btnId);

document.getElementById("btnContanti").classList.remove('selected');
document.getElementById("btnSatispay").classList.remove('selected');
document.getElementById("btnSumUp").classList.remove('selected');

if (metodoPagamentoSelezionato === metodo) {
metodoPagamentoSelezionato = null;
} else {
metodoPagamentoSelezionato = metodo;
button.classList.add('selected');
}

toggleCalcoloResto();
button.blur();
}

function toggleCalcoloResto() {
var sezioneContanti = document.getElementById("sezioneContanti");
var banconotaInput = document.getElementById("banconota");

if (metodoPagamentoSelezionato === 'Contanti') {
sezioneContanti.style.display = "block";
} else {
sezioneContanti.style.display = "none";
banconotaInput.value = "";
calcolaResto();
}
}

function calcolaResto() {
var banconotaInput = document.getElementById("banconota");
var restoDisplay = document.getElementById("resto");
var totaleElement = document.getElementById("totale");

var banconota = parseFloat(banconotaInput.value);
var totaleText = totaleElement.textContent.replace('€', '').replace(',', '.');
var totale = parseFloat(totaleText);

if (isNaN(banconota) || banconota <= 0) {
restoDisplay.textContent = "Resto: €0,00";
restoDisplay.className = "resto-display";
return;
}

var resto = banconota - totale;
var restoFormatted = '€' + Math.abs(resto).toFixed(2).replace('.', ',');

if (resto > 0) {
restoDisplay.textContent = 'Resto: ' + restoFormatted;
restoDisplay.className = "resto-display positive";
} else if (resto < 0) {
restoDisplay.textContent = 'Mancano: ' + restoFormatted;
restoDisplay.className = "resto-display negative";
} else {
restoDisplay.textContent = "Resto: €0,00";
restoDisplay.className = "resto-display";
}
}

function aggiornaPulsanteDinamico() {
  // Solo se siamo nella pagina gestionale
  if (document.getElementById('paginaGestionale').classList.contains('hidden')) return;
  
  var submitBtn = document.getElementById('btnRegistraVendita');
  if (!submitBtn) return;
  
var telefono = document.getElementById("telefono").value.trim();
var soloNumeri = telefono.replace(/[^0-9]/g, '');
var telefonoValido = soloNumeri.length >= 9;
  
var hasProdotti = false;
  
document.querySelectorAll("[id^='conf_']").forEach(function(input) {
if (input.type === "hidden") {
var qty = parseInt(input.value) || 0;
if (qty > 0) hasProdotti = true;
}
});
  
document.querySelectorAll("[id^='sfuso_']").forEach(function(input) {
if (input.id.endsWith('_calc')) return;
if (!input.classList || !input.classList.contains('sfuso-input')) return;
var valore = parseFloat(input.value);
if (!isNaN(valore) && valore > 0) hasProdotti = true;
});
  
if (telefonoValido && !hasProdotti) {
submitBtn.textContent = "Invita su WhatsApp";
submitBtn.classList.remove('error', 'success');
submitBtn.classList.add('invite');
submitBtn.style.background = "#28a745";
} else {
submitBtn.textContent = "Registra Vendita";
submitBtn.classList.remove('error', 'success', 'invite');
submitBtn.style.background = "#1a1a1a";
}
}

function invitaSoloWhatsApp() {
var telefono = document.getElementById("telefono").value.trim();
var cliente = document.getElementById("cliente").value.trim();
  
if (!cliente) {
cliente = "Cliente";
}
  
var testo = 'Ciao ' + cliente + '! \n\nTi invito a unirti al nostro gruppo WhatsApp "Golosone!" per rimanere aggiornato su tutti i nostri eventi e sapere dove trovarci!\n\nClicca qui:\nhttps://chat.whatsapp.com/ED9OnjSwRty2DFBozCLl5X\n\nA presto!\nSimona-Confetteria di Valle';
  
var linkWhatsapp = 'https://wa.me/' + telefono + '?text=' + encodeURIComponent(testo);
  
window.open(linkWhatsapp, '_blank');
  
var allBtns = document.querySelectorAll('.submit-btn');
var submitBtn = Array.from(allBtns).find(function(btn) { return !btn.closest('.hidden'); });
var originalText = submitBtn.textContent;
  
submitBtn.textContent = "✓ Invito inviato!";
submitBtn.disabled = true;
  
setTimeout(function() {
submitBtn.textContent = originalText;
submitBtn.disabled = false;
var nomeCliente = document.getElementById("cliente").value;
resetForm();
document.getElementById("cliente").value = nomeCliente;
}, 2000);
}

function invia() {
var telefono = document.getElementById("telefono").value.trim();
var soloNumeri = telefono.replace(/[^0-9]/g, '');
var telefonoValido = soloNumeri.length >= 9;
  
var hasProdotti = false;
  
document.querySelectorAll("[id^='conf_']").forEach(function(input) {
if (input.type === "hidden") {
var qty = parseInt(input.value) || 0;
if (qty > 0) hasProdotti = true;
}
});
  
document.querySelectorAll("[id^='sfuso_']").forEach(function(input) {
if (input.id.endsWith('_calc')) return;
if (!input.classList || !input.classList.contains('sfuso-input')) return;
var valore = parseFloat(input.value);
if (!isNaN(valore) && valore > 0) hasProdotti = true;
});
  
if (telefonoValido && !hasProdotti) {
invitaSoloWhatsApp();
return;
}
  
var cliente = document.getElementById("cliente").value.trim();
var condividiWhatsapp = document.getElementById("whatsapp") ? document.getElementById("whatsapp").checked : false;
var inputPersonalizzato = parseFloat(document.getElementById("personalizzato").value);
var totalePersonalizzato = !isNaN(inputPersonalizzato) && inputPersonalizzato > 0;

var allBtns = document.querySelectorAll('.submit-btn');
var submitBtn = Array.from(allBtns).find(function(btn) { return !btn.closest('.hidden'); });
var originalText = submitBtn.textContent;

if (submitBtn.disabled) {
return;
}

if (!cliente) {
cliente = "Cliente";
}

var confezionati = [];
document.querySelectorAll("[id^='conf_']").forEach(function(input) {
if (input.type === "hidden") {
var qty = parseInt(input.value) || 0;
var nome = input.dataset.nome;
if (qty > 0) confezionati.push(nome + ' x' + qty);
}
});

var sfuso = [];
document.querySelectorAll("[id^='sfuso_']").forEach(function(input) {
if (input.id.endsWith('_calc')) return;
if (!input.classList || !input.classList.contains('sfuso-input')) return;

var valore = parseFloat(input.value);
var nome = input.dataset.nome;

if (!isNaN(valore) && valore > 0) {
if (modalitaInput === "peso") {
sfuso.push({ nome: nome, grammi: valore });
} else {
// Da euro a grammi. Con un prezzo mancante nel Foglio verrebbe NaN, e i
// grammi finirebbero così nel registro: meglio non mandare la riga e
// lasciare che il server dica quale cella manca.
var prezzoKg   = (tipoVendita === "Privati" ? prezziKgPrivati   : prezziKgNegozi)[nome];
var prezzoEtto = (tipoVendita === "Privati" ? prezziEttoPrivati : prezziEttoNegozi)[nome];
var buono = function (v) { return typeof v === 'number' && isFinite(v) && v > 0; };
var grammiCalcolati;

if (buono(prezzoKg) && valore >= prezzoKg) {
grammiCalcolati = (valore / prezzoKg) * 1000;
} else if (buono(prezzoEtto)) {
grammiCalcolati = (valore / prezzoEtto) * 100;
}

if (grammiCalcolati > 0) sfuso.push({ nome: nome, grammi: grammiCalcolati });
}
}
});

if (confezionati.length === 0 && sfuso.length === 0) {
submitBtn.textContent = "Inserisci almeno un prodotto";
submitBtn.classList.remove('success', 'invite');
submitBtn.classList.add('error');
submitBtn.disabled = true;
submitBtn.style.pointerEvents = 'none';

setTimeout(function() {
submitBtn.textContent = originalText;
submitBtn.classList.remove('error');
submitBtn.disabled = false;
submitBtn.style.pointerEvents = 'auto';
}, 2000);
return;
}

// Totale mostrato sul tablet: il server lo confronta col proprio calcolo (guardia prezzi).
var _totMostratoTxt = document.getElementById("totale").textContent.replace('€', '').replace(',', '.');
var totaleMostrato = parseFloat(_totMostratoTxt);

var dati = {
tipoVendita: tipoVendita,
cliente: cliente,
negozio: (tipoVendita === "Negozi" ? datiNegozioCorrente() : null),
numeroFattura: (tipoVendita === "Negozi" ? numeroFatturaScelto() : null),
giorniPagamento: (tipoVendita === "Negozi" ? giorniPagamentoScelti() : null),
speseSpedizione: (tipoVendita === "Negozi" ? spedizioneScelta().imponibile : 0),
telefono: telefono,
condividiWhatsapp: condividiWhatsapp,
totalePersonalizzato: totalePersonalizzato,
importoPersonalizzato: inputPersonalizzato,
totaleMostrato: totaleMostrato,
confezionati: confezionati,
sfuso: sfuso,
metodoPagamento: metodoPagamentoSelezionato,
// Bandierina FISCALITÀ: false solo se l'operatrice l'ha messa sul rosso.
// Il server controlla `!== false`, quindi se questo campo non arrivasse
// affatto — vendita rimasta in coda da prima, client vecchio — i documenti
// si emettono lo stesso: sbagliare per eccesso, non per difetto.
fiscalita: fiscalitaAttiva(),
nomeEvento: sessionStorage.getItem('nomeEvento') || ''
};

submitBtn.textContent = "Salvando...";
submitBtn.classList.remove('success', 'error', 'invite');
submitBtn.disabled = true;
submitBtn.style.pointerEvents = 'none';

sistemaOffline.aggiungiVendita(dati);

// Invito Golosone su WhatsApp: aperto SUBITO nel gesto del click (non alla sincronizzazione),
// così parte mentre il cliente è ancora al banco e senza pop-up multipli in ritardo.
if (condividiWhatsapp && telefono) {
var _invito = 'Ciao ' + (cliente || 'Cliente') + '! Grazie dell\'acquisto.\n\nSe ti fa piacere unisciti al gruppo "Golosone!" per sapere dove trovarci:\nhttps://chat.whatsapp.com/ED9OnjSwRty2DFBozCLl5X\n\nA presto! Simona - Confetteria di Valle';
window.open('https://wa.me/' + telefono + '?text=' + encodeURIComponent(_invito), '_blank');
}

setTimeout(function() {
if (condividiWhatsapp && telefono) {
mostraOverlaySuccesso(confezionati, sfuso, 3);
} else {
mostraOverlaySuccesso(confezionati, sfuso);
}

setTimeout(function() {
resetForm();
submitBtn.textContent = originalText;
submitBtn.classList.remove('success');
submitBtn.disabled = false;
submitBtn.style.pointerEvents = 'auto';
window.scrollTo({ top: 0, behavior: 'smooth' });
}, 2000);
}, 500);
}

function mostrarMessaggio(messaggio, tipo) {
var contenitore = document.getElementById("risposta");
contenitore.innerHTML = '<div class="response-message ' + tipo + '">' + messaggio + '</div>';

setTimeout(function() {
contenitore.innerHTML = "";
}, 5000);
}

function mostraOverlaySuccesso(confezionati, sfuso, durata) {
durata = durata || 60;
  
var overlay = document.createElement('div');
overlay.className = 'success-overlay';

var listaProdotti = '';

if (confezionati.length > 0) {
listaProdotti += '<h4>Prodotti Confezionati:</h4><ul>';
confezionati.forEach(function(item) {
listaProdotti += '<li>' + item + '</li>';
});
listaProdotti += '</ul>';
}

if (sfuso.length > 0) {
if (confezionati.length > 0) listaProdotti += '<br>';
listaProdotti += '<h4>Prodotti Sfusi:</h4><ul>';
sfuso.forEach(function(item) {
listaProdotti += '<li>' + item.nome + ' - ' + item.grammi + 'g</li>';
});
listaProdotti += '</ul>';
}

overlay.innerHTML = '<div class="success-overlay-content"><button class="success-overlay-close" onclick="chiudiOverlaySuccesso()">×</button><h3><span class="success-checkmark">✓</span>Vendita Salvata</h3><div class="success-overlay-products">' + listaProdotti + '</div><div class="success-overlay-timer" id="successTimer">Si chiude automaticamente in ' + durata + ' secondi</div></div>';

overlay.id = 'successOverlay';
document.body.appendChild(overlay);

setTimeout(function() { overlay.classList.add('show'); }, 10);

var secondi = durata;
var timerElement = document.getElementById('successTimer');

var countdown = setInterval(function() {
secondi--;
if (secondi > 0) {
timerElement.textContent = 'Si chiude automaticamente in ' + secondi + ' secondi';
} else {
clearInterval(countdown);
chiudiOverlaySuccesso();
}
}, 1000);

overlay.dataset.timerId = countdown;
}

function chiudiOverlaySuccesso() {
var overlay = document.getElementById('successOverlay');
if (overlay) {
if (overlay.dataset.timerId) {
clearInterval(parseInt(overlay.dataset.timerId));
}

overlay.classList.remove('show');
setTimeout(function() { overlay.remove(); }, 300);
}
}

document.addEventListener('DOMContentLoaded', function() {
var btnPrivati = document.getElementById('btnPrivati');
var btnNegozi = document.getElementById('btnNegozi');
if (btnPrivati) btnPrivati.addEventListener('click', function() { iniziaVendita('Privati'); });
if (btnNegozi) btnNegozi.addEventListener('click', function() { iniziaVendita('Negozi'); });

var btnIndietroSelezione = document.getElementById('btnIndietroSelezione');
if (btnIndietroSelezione) btnIndietroSelezione.addEventListener('click', tornaATipoVendita);

var btnConfermaSelez = document.getElementById('btnConfermaSelez');
if (btnConfermaSelez) btnConfermaSelez.addEventListener('click', confermaSelezioneProdotti);

var btnIndietroGestionale = document.getElementById('btnIndietroGestionale');
if (btnIndietroGestionale) btnIndietroGestionale.addEventListener('click', tornaIndietro);

var btnRegistraVendita = document.getElementById('btnRegistraVendita');
if (btnRegistraVendita) btnRegistraVendita.addEventListener('click', invia);

var btnContanti = document.getElementById('btnContanti');
if (btnContanti) btnContanti.addEventListener('click', function() { togglePagamento('Contanti'); });

var btnSatispay = document.getElementById('btnSatispay');
if (btnSatispay) btnSatispay.addEventListener('click', function() { togglePagamento('Satispay'); });

var btnSumUp = document.getElementById('btnSumUp');
if (btnSumUp) btnSumUp.addEventListener('click', function() { togglePagamento('SumUp'); });

var togglePesoImporto = document.getElementById('togglePesoImporto');
if (togglePesoImporto) togglePesoImporto.addEventListener('change', toggleInputMode);

var numericInputs = document.querySelectorAll('input[inputmode="tel"], input[inputmode="decimal"], input[inputmode="numeric"]');

numericInputs.forEach(function(input) {
input.addEventListener('keydown', function(e) {
if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
e.preventDefault();
e.stopPropagation();
this.blur();
document.activeElement.blur();
}
});

input.addEventListener('focusout', function() {
this.blur();
});
});

var telefonoInput = document.getElementById('telefono');
if (telefonoInput) {
telefonoInput.addEventListener('input', function() {
validaTelefono(this);
});
}

var banconotaInput = document.getElementById('banconota');
if (banconotaInput) {
banconotaInput.addEventListener('input', function() {
validaNumeroBanconota(this);
});
}

var personalizzatoInput = document.getElementById('personalizzato');
if (personalizzatoInput) {
personalizzatoInput.addEventListener('input', function() {
validaNumeroPersonalizzato(this);
});
}

/* Spedizione: a ogni cifra si rifà il totale e la nota sotto il campo. */
var spedInput = document.getElementById('speseSpedizione');
if (spedInput) {
spedInput.addEventListener('input', function() { aggiornaTotali(); });
}

sistemaOffline = new SistemaOffline();

var pageObserver = new MutationObserver(toggleFineButton);
pageObserver.observe(document.querySelector('.container'), {
childList: true,
subtree: true,
attributes: true,
attributeFilter: ['class']
});

setTimeout(toggleFineButton, 100);
});

var protezioneRefresh = function(e) {
e.preventDefault();
e.returnValue = '';
return '';
};

window.addEventListener('beforeunload', protezioneRefresh);

document.addEventListener('click', function() {
window.removeEventListener('beforeunload', protezioneRefresh);

setTimeout(function() {
window.addEventListener('beforeunload', protezioneRefresh);
}, 100);
});

window.addEventListener('online', function() {
sistemaOffline.verificaConnessione();
sistemaOffline.mostraNotifica('Connessione ripristinata', 2000, 'success');
});

window.addEventListener('offline', function() {
sistemaOffline.verificaConnessione();
sistemaOffline.mostraNotifica('Modalità offline attiva', 3000, 'warning');
});

function toggleFineButton() {
var fineBtn = document.getElementById('fineBtn');

if (!fineBtn) {
fineBtn = document.createElement('button');
fineBtn.id = 'fineBtn';
fineBtn.className = 'fine-button';
fineBtn.textContent = 'FINE';
fineBtn.onclick = confermaFineGiornata;
document.body.appendChild(fineBtn);
}

var paginaGestionale = document.getElementById('paginaGestionale');
if (paginaGestionale && !paginaGestionale.classList.contains('hidden') && tipoVendita === 'Privati') {
fineBtn.style.display = 'block';
} else {
fineBtn.style.display = 'none';
}
}

function confermaFineGiornata() {
var modal = document.createElement('div');
modal.className = 'fine-modal';

modal.innerHTML = '<div class="fine-modal-content"><h3>Terminare la giornata?</h3><p>Verrà salvato il report della giornata e tornerai alla schermata iniziale.</p><div class="fine-modal-buttons"><button class="confirm" onclick="eseguiFineGiornata()">Conferma</button><button class="cancel" onclick="chiudiFineModal()">Annulla</button></div></div>';

document.body.appendChild(modal);
}

function chiudiFineModal() {
var modal = document.querySelector('.fine-modal');
if (modal) modal.remove();
}

function eseguiFineGiornata() {
chiudiFineModal();

var fineBtn = document.getElementById('fineBtn');
var originalText = fineBtn.textContent;

fineBtn.textContent = 'Salvataggio...';
fineBtn.classList.add('loading');
fineBtn.disabled = true;

var nomeEvento = sessionStorage.getItem('nomeEvento') || '';

window.removeEventListener('beforeunload', protezioneRefresh);

var timeoutId = setTimeout(function() {
sistemaOffline.mostraNotifica('Operazione in timeout - riprova', 3000, 'error');
fineBtn.textContent = originalText;
fineBtn.classList.remove('loading');
fineBtn.disabled = false;
window.addEventListener('beforeunload', protezioneRefresh);
}, 30000);

var salvaReport = function() {
console.log('Inizio salvataggio report...');
google.script.run
.withSuccessHandler(function(result) {
clearTimeout(timeoutId);
console.log('Report salvato con successo:', result);
if (result.success) {
sistemaOffline.mostraNotifica(
'Report salvato: ' + result.data.numeroVendite + ' vendite, Netto: €' + result.data.netto.toFixed(2),
4000,
'success'
);

resetForm();
document.getElementById('paginaGestionale').classList.add('hidden');
document.getElementById('selezioneProdotti').classList.add('hidden');
document.getElementById('sceltaTipoVendita').classList.remove('hidden');

prodottiSelezionati = { confezionati: [], sfusi: [] };
document.getElementById('nomeEvento').value = '';
sessionStorage.removeItem('nomeEvento');
sessionStorage.removeItem('prodottiSelezionati');

fineBtn.textContent = originalText;
fineBtn.classList.remove('loading');
fineBtn.disabled = false;

setTimeout(function() {
window.addEventListener('beforeunload', protezioneRefresh);
}, 1000);
} else {
sistemaOffline.mostraNotifica('Errore nel salvataggio del report', 3000, 'error');
fineBtn.textContent = originalText;
fineBtn.classList.remove('loading');
fineBtn.disabled = false;

window.addEventListener('beforeunload', protezioneRefresh);
}
})
.withFailureHandler(function(error) {
clearTimeout(timeoutId);
console.error('Errore report:', error);
sistemaOffline.mostraNotifica('Errore: ' + error, 3000, 'error');
fineBtn.textContent = originalText;
fineBtn.classList.remove('loading');
fineBtn.disabled = false;

window.addEventListener('beforeunload', protezioneRefresh);
})
.salvaReportFineGiornata(nomeEvento);
};

if (sistemaOffline.coda.length > 0) {
console.log('Vendite in coda:', sistemaOffline.coda.length);
sistemaOffline.mostraNotifica('Backup vendite in corso...', 2000, 'info');

google.script.run
.withSuccessHandler(function(risultato) {
console.log('Backup completato:', risultato);
if (risultato.success) {
sistemaOffline.mostraNotifica('Backup completato', 1500, 'success');
setTimeout(salvaReport, 1500);
} else {
sistemaOffline.mostraNotifica('Backup fallito, procedo con il report', 2000, 'warning');
setTimeout(salvaReport, 2000);
}
})
.withFailureHandler(function(errore) {
console.error('Errore backup:', errore);
sistemaOffline.mostraNotifica('Backup fallito, procedo con il report', 2000, 'warning');
setTimeout(salvaReport, 2000);
})
.salvaBackupDrive({
timestamp: new Date().toISOString(),
dispositivo: navigator.userAgent,
vendite: sistemaOffline.coda
});
} else {
console.log('Nessuna vendita in coda, procedo con report');
salvaReport();
}
}
/* ════════════════════════════════════════════
   FATTURA AI NEGOZI — anagrafica e scaricamento

   Modello ibrido: si scrive il nome del negozio; se è già in
   anagrafica i campi fiscali restano chiusi e si usano quelli
   salvati, se è nuovo si aprono da compilare e alla vendita
   vengono memorizzati.

   Il file XML non lo produce il browser: arriva dal server come
   testo e qui si salva con un Blob, come l'.ics del sito.
   ════════════════════════════════════════════ */
(function () {
  'use strict';

  var trovato = null;          // anagrafica del negozio scritto nel campo
  var ultimoCercato = '';

  var campo    = function (id) { return document.getElementById(id); };
  var normaliz = function (s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); };

  /* Elenco nomi per la tendina: si carica una volta per sessione. */
  var elencoCaricato = false;
  window.caricaElencoNegozi = function () {
    if (elencoCaricato) return;
    elencoCaricato = true;
    google.script.run
      .withSuccessHandler(function (nomi) {
        var dl = campo('elencoNegozi');
        if (!dl) return;
        dl.innerHTML = '';
        (nomi || []).forEach(function (n) {
          var o = document.createElement('option');
          o.value = n;
          dl.appendChild(o);
        });
      })
      .withFailureHandler(function () { elencoCaricato = false; })
      .elencoNomiNegozi();
  };

  /* Cerca il negozio quando si finisce di scrivere il nome. */
  function cerca() {
    var nome = campo('cliente') ? campo('cliente').value.trim() : '';
    if (normaliz(nome) === ultimoCercato) return;
    ultimoCercato = normaliz(nome);

    if (!nome) { mostra(null); return; }

    google.script.run
      .withSuccessHandler(mostra)
      .withFailureHandler(function () { mostra(null); })
      .cercaNegozio(nome);
  }

  function mostra(neg) {
    trovato = neg;
    var box   = campo('datiNegozio');
    var noto  = campo('negozioTrovato');
    var nuovo = campo('negozioNuovo');
    if (!box || box.style.display === 'none') return;

    if (neg) {
      noto.textContent = '✓ ' + neg.ragioneSociale + ' — P.IVA ' + neg.piva +
                         ' — ' + neg.comune + ' (' + neg.provincia + ')';
      noto.style.display = 'block';
      nuovo.style.display = 'none';
    } else {
      noto.style.display = 'none';
      nuovo.style.display = campo('cliente').value.trim() ? 'block' : 'none';
    }
  }

  /* Rimette il blocco negozio come appena aperto: via la riga verde, via il
     modulo del negozio nuovo, e soprattutto via l'anagrafica tenuta in memoria.
     La chiama resetForm() dopo ogni vendita registrata.

     Azzerare `trovato` non e' pulizia estetica: e' la stessa variabile che
     finisce nel payload della vendita successiva. Lasciarla piena vorrebbe dire
     intestare la prossima fattura al negozio di prima. */
  window.azzeraNegozio = function () {
    trovato = null;
    ultimoCercato = '';
    var noto = campo('negozioTrovato');
    if (noto) { noto.textContent = ''; noto.style.display = 'none'; }
    var nuovo = campo('negozioNuovo');
    if (nuovo) nuovo.style.display = 'none';
  };

  /* Stessa normalizzazione di _chiaveNome_ sul server: minuscole, accenti via,
     spazi compattati. Serve per confrontare mele con mele. */
  function chiaveNome(s) {
    return String(s || '').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ');
  }

  /* Quello che viaggia col payload della vendita. */
  window.datiNegozioCorrente = function () {
    /* L'anagrafica in memoria vale SOLO se il nome scritto e' ancora il suo.
       La ricerca parte quando si esce dal campo ed e' asincrona: se si corregge
       il nome e si preme subito Registra, la risposta puo' non essere ancora
       arrivata e `trovato` conterrebbe il negozio precedente — fattura al
       cliente sbagliato, con un numero gia' bruciato e non piu' recuperabile.

       Nel dubbio si scarta. Non si perde niente: il server rifa' comunque
       cercaNegozio(data.cliente) per conto suo. Sbagliare per prudenza qui non
       costa nulla, sbagliare nell'altro senso costa una fattura da rifare. */
    if (trovato) {
      var scritto = campo('cliente') ? chiaveNome(campo('cliente').value) : '';
      if (scritto && scritto === chiaveNome(trovato.nome)) return trovato;
      trovato = null;
    }
    var v = function (id) { return campo(id) ? campo(id).value.trim() : ''; };
    if (!v('negRagione') && !v('negPiva')) return null;      // niente da mandare
    return {
      nome: v('cliente'),
      ragioneSociale: v('negRagione'),
      piva: v('negPiva').replace(/\s/g, ''),
      codiceFiscale: '',
      indirizzo: v('negIndirizzo'),
      cap: v('negCap'),
      comune: v('negComune'),
      provincia: v('negProv').toUpperCase(),
      codiceSdi: v('negSdi').toUpperCase(),
      pec: v('negPec')
    };
  };

  /* ── SCADENZA DEL PAGAMENTO ──
     Le caselle stanno dentro #datiNegozio, quindi si vedono solo sui
     Negozi. Riusano le classi dei metodi di pagamento: stesso aspetto,
     nessun CSS nuovo. */
  window.giorniPagamentoScelti = function () {
    var sel = document.querySelector('#datiNegozio .payment-button.selected');
    return sel ? parseInt(sel.getAttribute('data-giorni'), 10) : 0;
  };

  function collegaScadenze() {
    var caselle = document.querySelectorAll('#datiNegozio .payment-button[data-giorni]');
    for (var i = 0; i < caselle.length; i++) {
      caselle[i].addEventListener('click', function () {
        for (var j = 0; j < caselle.length; j++) caselle[j].classList.remove('selected');
        this.classList.add('selected');
      });
    }
  }

  /* ── NUMERO FATTURA ──
     Il minimo lo decide il server; qui si impedisce solo di scendere
     sotto, così l'operatrice se ne accorge subito e non a vendita fatta. */
  var numeroMinimo = null;

  window.caricaNumeroSuggerito = function () {
    google.script.run
      .withSuccessHandler(function (r) {
        var input = campo('numeroFattura');
        var nota  = campo('numeroFatturaNota');
        if (!input) return;
        if (!r || !r.success) {
          input.value = '';
          input.disabled = true;
          if (nota) { nota.textContent = r && r.errore ? r.errore : 'numerazione non configurata'; nota.style.color = '#c62828'; }
          return;
        }
        numeroMinimo = r.numero;
        input.disabled = false;
        input.min = r.numero;
        if (!input.value || Number(input.value) < r.numero) input.value = r.numero;
        if (nota) { nota.textContent = 'suggerito ' + r.etichetta; nota.style.color = '#777'; }
      })
      .withFailureHandler(function () {
        var nota = campo('numeroFatturaNota');
        if (nota) { nota.textContent = 'suggerimento non disponibile'; nota.style.color = '#c62828'; }
      })
      .numeroFatturaSuggerito();
  };

  window.numeroFatturaScelto = function () {
    var input = campo('numeroFattura');
    if (!input || !input.value) return null;
    return parseInt(input.value, 10);
  };

  function controllaNumero() {
    var input = campo('numeroFattura');
    var nota  = campo('numeroFatturaNota');
    if (!input || numeroMinimo === null) return;
    var v = parseInt(input.value, 10);
    if (!isNaN(v) && v < numeroMinimo) {
      input.value = numeroMinimo;
      if (nota) {
        nota.textContent = 'il ' + v + ' è già usato: il primo libero è ' + numeroMinimo;
        nota.style.color = '#c62828';
      }
    } else if (nota && nota.style.color === 'rgb(198, 40, 40)') {
      nota.textContent = 'suggerito ' + numeroMinimo;
      nota.style.color = '#777';
    }
  }

  /* Salva il file XML restituito dal server. Torna true se il salvataggio è
     partito: chi chiama toglie la fattura dalla pila solo in quel caso, così
     un errore non la fa sparire dallo schermo. */
  window.scaricaFatturaXml = function (fattura) {
    try {
      var blob = new Blob([fattura.xml], { type: 'application/xml;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fattura.nomeFile;
      document.body.appendChild(a);
      // Il link finto va tolto anche se il click salta, se no a ogni tentativo
      // fallito ne resta uno appeso alla pagina.
      try { a.click(); } finally {
        if (a.parentNode) a.parentNode.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      }
      if (typeof sistemaOffline !== 'undefined' && sistemaOffline.mostraNotifica) {
        var quando = fattura.scadenza ? ' — scade il ' + fattura.scadenza.split('-').reverse().join('/') : '';
        sistemaOffline.mostraNotifica('Fattura ' + fattura.numero + ' scaricata' + quando, 4000, 'success');
      }
      return true;
    } catch (e) {
      console.error('Scaricamento fattura fallito:', e);
      alert('La fattura ' + fattura.numero + ' è stata emessa e il numero è bruciato, ' +
            'ma il file XML non si è salvato.\n\n' +
            'Il pulsante Scarica resta a destra: riprova. ' +
            'La copia PDF intanto è su Drive, nella cartella Fatture, ' +
            'col link sulla riga della vendita nel registro Negozi.');
      return false;
    }
  };


  /* ═══════════════════════════════════════════════════════════
     FATTURE IN ATTESA — RETE DI SICUREZZA

     Nel funzionamento normale questa pila resta VUOTA: l'XML lo salva il
     server su Drive e dal tablet non si scarica niente.

     Serve solo quando Drive non ha preso il file. Lì il numero di fattura è
     già bruciato e l'XML esiste unicamente nella risposta arrivata al tablet:
     se si perde quello, non esiste da nessuna parte. Allora compare la pillola
     a destra con dentro «Scarica», e il file parte quando la premi.

     Perché non parte da solo: un download che il codice avvia per conto suo,
     senza un tocco recente dell'utente, i browser lo rifiutano — Safari su
     iPad sempre, Chrome dal secondo in poi. E a.click() NON solleva niente
     quando viene bloccato, quindi un try/catch non se ne accorgerebbe:
     numero bruciato, notifica «scaricata», file mai arrivato.

     La lista sta in localStorage come la coda delle vendite: se il tablet si
     riavvia o la pagina si ricarica, le fatture da salvare sono ancora lì.
     ═══════════════════════════════════════════════════════════ */

  var FATT_CHIAVE = 'caramelle_fatture_attesa';

  function _fattLeggi() {
    try {
      var v = JSON.parse(localStorage.getItem(FATT_CHIAVE) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function _fattScrivi(lista) {
    try { localStorage.setItem(FATT_CHIAVE, JSON.stringify(lista)); }
    catch (e) { console.error('Fatture in attesa non salvate:', e); }
  }

  function _fattContenitore() {
    var c = document.getElementById('fattureInAttesa');
    if (!c) {
      c = document.createElement('div');
      c.id = 'fattureInAttesa';
      document.body.appendChild(c);
    }
    return c;
  }

  /* Ridisegna la pila dalla lista salvata. */
  function _fattDisegna() {
    var c = _fattContenitore();
    c.innerHTML = '';
    _fattLeggi().forEach(function (f) {
      var pillola = document.createElement('div');
      pillola.className = 'fattura-attesa';

      var testo = document.createElement('span');
      testo.textContent = 'Fattura ' + f.numero;
      pillola.appendChild(testo);

      var bottone = document.createElement('button');
      bottone.type = 'button';
      bottone.textContent = 'Scarica';
      bottone.addEventListener('click', function () {
        // Qui c'è il tocco dell'utente: il download passa. Se però qualcosa
        // va storto la pillola resta, così il file non si perde comunque.
        if (window.scaricaFatturaXml(f)) _fattRimuovi(f.nomeFile);
      });
      pillola.appendChild(bottone);

      c.appendChild(pillola);
      pillola.offsetHeight;
      setTimeout(function () { pillola.classList.add('show'); }, 10);
    });
  }

  /* Il nomeFile è la chiave: stessa fattura riscaricata, stesso nome, nessun
     doppione nella pila. */
  function _fattRimuovi(nomeFile) {
    _fattScrivi(_fattLeggi().filter(function (x) { return x.nomeFile !== nomeFile; }));
    _fattDisegna();
  }

  window.fatturaInAttesa = function (fattura) {
    if (!fattura || !fattura.xml) return;
    var lista = _fattLeggi().filter(function (x) { return x.nomeFile !== fattura.nomeFile; });
    lista.push({
      numero: fattura.numero,
      nomeFile: fattura.nomeFile,
      xml: fattura.xml,
      scadenza: fattura.scadenza || null
    });
    _fattScrivi(lista);
    _fattDisegna();
  };

  // Al caricamento: quello che era rimasto da scaricare torna a farsi vedere.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _fattDisegna);
  } else {
    _fattDisegna();
  }

  /* Il negozio nuovo si memorizza appena i dati sono completi, senza
     aspettare la vendita: se la sincronizzazione avviene più tardi
     l'anagrafica è già a posto. */
  window.memorizzaNegozioSeNuovo = function () {
    if (trovato) return;
    var n = window.datiNegozioCorrente();
    if (!n || !n.ragioneSociale || !n.piva) return;
    google.script.run
      .withSuccessHandler(function (r) {
        if (r && r.success) { trovato = n; elencoCaricato = false; caricaElencoNegozi(); }
      })
      .salvaNegozio(n);
  };

  document.addEventListener('DOMContentLoaded', function () {
    var c = campo('cliente');
    if (c) {
      c.addEventListener('change', cerca);
      c.addEventListener('blur', cerca);
    }
    collegaScadenze();
    var nf = campo('numeroFattura');
    if (nf) { nf.addEventListener('change', controllaNumero); nf.addEventListener('blur', controllaNumero); }
    ['negRagione','negPiva','negIndirizzo','negCap','negComune','negProv','negSdi','negPec']
      .forEach(function (id) {
        var e = campo(id);
        if (e) e.addEventListener('blur', window.memorizzaNegozioSeNuovo);
      });
  });
})();
/* ═══════════════════════════════════════════════════════════
   STAMPANTE TERMICA BLUETOOTH (PT-210)

   Copia di cortesia su carta dello scontrino appena battuto. È uno strato
   aggiuntivo e basta: consuma i dati che il server ha già prodotto
   (risposta.stampa, costruita da _datiStampaScontrino_ in Code.gs) e non
   tocca né l'emissione Datacash, né i prezzi, né i totali, né la fattura.

   Regola non negoziabile: la carta non blocca mai niente. Stampante spenta,
   Bluetooth negato, foglio finito, errore a metà invio — la vendita resta
   registrata e lo scontrino fiscale resta emesso. Qui dentro ogni errore si
   ferma su un avviso che scompare da solo.

   Il collegamento vive quanto la scheda: Chrome apre il selettore Bluetooth
   solo dentro un gesto dell'utente, quindi non si può riagganciare da soli
   al caricamento. Si preme «Stampante» una volta a inizio giornata.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // UUID del servizio seriale della PT-210 e caratteristica di scrittura.
  // Il filtro per servizio in requestDevice con questa stampante non funziona
  // (non lo mette in advertising): si chiede tutto e si dichiara il servizio
  // fra gli optionalServices, altrimenti dopo la connessione è irraggiungibile.
  var SERVIZIO = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
  var CARATTERISTICA = '49535343-8841-43f4-a8d4-ecbe34729bb3';

  // Densità di stampa (comando DC2 # n = 0x12 0x23 n). Più basso = più
  // chiaro. Su carta diversa serve ritararla: si cambia questo numero, oppure
  // dalla console `stampante.densita(10)` che se la ricorda sul tablet.
  var DENSITA_DEFAULT = 8;
  var DENSITA_CHIAVE = 'caramelle_stampa_densita';

  // Font A su carta 58mm: 32 caratteri per riga, 48mm stampabili.
  var COLONNE = 32;

  var ESC = 0x1B, LF = 0x0A;

  // Logo raster (GS v 0), lo stesso marchio della fattura convertito in
  // bitmap monocromatica: la termica non sa disegnare un PNG.
  var LOGO_B64 = "HXYwADAAkQAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wfwAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/APwAAAAAAAAAAAAAAAAAAAAAAAAD/gAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAD+AHwAAAAAAAAAAAAAAAAAAAAAAAAP/wAAA4AAAAAAAAAAAAAAAAf4AAAAAAAAAAD8AH4AAAAAAAAAAAAAAAAAAAAAAAAP/4AAD/wAAAAAAAAAAAAAAA/8AAAAAAAAAAH4AD4AAAAAAAAAAAAAAAAAAAAAAAAf/8AAH/4AAAAAAAAAAAAAAA/8AAAAAAAAAAPwAD4AAAAAAAAAAAAAAAAAAAAAAAA/j8AAP/8AAAAAAAAAAAAAAB/+AAAAAAAAAAPgAB4AAAAAAAAAAAAAAAAAAAAAAAB+A+AAf/+AAAAAAAAAAAAAAB/+AAAAAAAAAAfAAB4AAAAAAAAAAAAAAAAAAAAAAAB8AfAA/gfAAAAAAAAAAAAAAB/+AAAAAAAAAA/AAB4AAAAAAAAAAAAAAAAAAAAAAAD4APAA+APAAAAAAAAAAAAEAB8eAAAAAAAAAA+AAB8AAAAAAAAAAAAAAAAAAAAAAADwAHgB8AHgAAAAAAAAAAB/gB4fAAAAAAAAAB+AAA8AAAAAAAAAAAAAAAAAAAAAAAHwAHgB4ADwAAAOAAAAAAD/wDwfAAAAAAAAAB8AAA8AAAAAAAAAAAAAAAAAAAAAAAHgADwD4ABwAAB/gAAAAAD/wDwPAAAAAAAAAD4AAA8AAAAAAAAAAAAAAAAAAAAAAAPAADwDwAB4AAD/4AAAAAH/4DwPAAAAAAAAAD4AAA8AAAAAAAAAAAAAAAAAAAAAAAPAABwHwAB4AAH/4AAAAAH/4DwPAAAAAAAAAHwAAA8AAAAAAAAAAAAAAAAAAAAAAAeAAB4HgAA4AAP/8AAAAAHx4DwPAAAAAAAAAHwAAA8AAAAAAAAAAAAAAAAAAAAAAAeAAA4HgAA8AAf/+AAAAAHh8DwPAAAAAAAAAHgAAA8AAAAAAAAAAAAAAAAAAAAAAA8AAA4PAAA8AA/g+AAAAAHh8DwPAAAAAAAAAPgAAA8AAAAAAAAAAAAAAAAAAAAAAA8AAA8PAAAcAA/AfAAAAAPB8DwPAAAAAAAAAPAAAA8AAAAAAAAAAAAAAAAAAAAAAA8AAA8PAAAcAB+APAAAAAPA8DwPAAAAAAAAAfAAAA8AAAAAAAAAAAAAAAAAAAAAAB4AAAcPAAAeAB8APAAAAAPA8DwPAAAAAAAAAfAAAA8AAAAAAAAAAAAAAAAAAAAAAB4AAAceAAAOAD4AHgAAAAPA8DwPAAAAAAAAAeAAAAcAAAAAAAAAAAAAAAAAAAAAABwAAAeeAAAOADwAHgAAAAPA8DwPAAAAAAAAA+AAAAcAAAAAAAAAAAAAAAAAAAAAADwAAAeeAAAOAHwAHgAAAAPA8DwPAAAAAAAAA+AAAAcAAAAAAAAAAAAAAAAAAAAAADwAAAO+AAAOAHgADwAAAAPA8BwPAAAAAAAAA+AAAAeAAAAAAAAAAAAAAAAAAAAAADgAAAP+AAAHAHgADwAAAAPA8BwPAAAAAAAAA8AAAAeAAAAAAAAAAAAAAAAAAAAAAHgAAAP8AAAHAPgADwAAAAPA8BwPAAAAAAAAB8AAAAeAAAAAAAAAAAAAAAAAAAAAAHgAAAP8AAAHAPAADwAAAAPA8BwPAAAAAAAAB8AAAAeAAAAAAAAAAAAAAAAAAAAAAHgAAAP8AAAHAPAABwAAAAPA8BwPAAAAAAAAB4AAAAeAAAAAAAAAAAAAAAAAAAAAAHAAAAH8AAAHgPAAB4AAAAPA8BwPAAAAAAAAB4AAAAeAAAAAAAAAAAAAAAAAAAAAAPAAAAH8AAADgeAAB4AAAAHA8BwPAAAAAAAAB4AAAAeAAAAAAAAAAAAAAAAAAAAAAPAAAAH8AAADgeAAB4AAAAHA8BwPAAAAAAAAD4AAAAeAAAAAAAAAAAAAAAAAAAAAAPAAAAH8AAADgeAAB4AAAAHA8A4PAAAAAAAAD4AAAAeAAAAAAAAAAAAAAAAAAAAAAOAAAAH4AAADgeAAA4AAAAHA8A4PAAAAAAAADwAAAAeAAAAAAAAAAAAAAAAAAAAAAOAAAAH4AAADw8AAA4AAAAHA8A4PAAAAAAAADwAAAAeAAAAAAAAAAAAAAAAAAAAAAOAAAAD4AAADw8AAA4AAAAHA8A4PAAAAAAAADwAAAAeAAAAAAAAAAAAAAAAAAAAAAeAAAAD4AAABw8AAA4AAAAHA8A4PAAAAAAAADwAAAAcAAAAAAAAAAAAAAAAAAAAAAeAAAAD4AAABw8AAA8AAAADg8A4PAAAAAAAADwAAAAcAAAAAAAAAAAAAAAAAAAAAAcAAAAD4AAABw4AAA8AAAADg8AYPAAAAAAAADgAAAAIAAAAAAAAAAAAAAAAAAAAAAcAAAAD4AAAB44AAA8AAAADg8AcPAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAD4AAAB54AAA8AAAADg8AcPAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAD4AAAA54AAA8AAAADg8AcOAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAD4AAAA54AAAcAAAABg8AMOAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAB4AAAA54AAAcAAAABw4AMOAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAB4AAAA/4AAAcAAAABw4AOOAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAB4AAAA/wAAAcAAAABw4AOOAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAABw4AOeAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAAAw4AHeAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAAA54AH+AAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAAA54AH+AAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAAA54AH+AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAeAAAAAf4AH+AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAfwAAAOAAAAAf4AD+AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAPwAAAOAAAAAf4AD8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAB4AAAAPwAAAOAAAAAf4AD8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAB4AAAAPwAAAOAAAAAPwAD8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAB8AAAAPwAAAOAAAAAPwAD8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAB8AAAAPwAAAOAAAAAPwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAB8AAAAPwAAAPAAAAAPwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAB8AAAAPwAAAPAAAAAPwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAB8AAAAPwAAAPAAAAAHwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAA8AAAAPwAAAPAAAAAHwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAA8AAAAHwAAAPAAAAAHwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAA8AAAAHwAAAPAAAAAHwAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAA8AAAAHwAAAHAAAAAHgAB8AAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAA8AAAAHwAAAHAAAAAHgAB8AAAAAAAAPgAAAAAAAAAAAAAAD4AAAAAAAAAABwAAAAA+AAAAHwAAAHAAAAAHgAB8AAAAAAAAHgAAAAAAAAAAAAAAH/j/AAAAAAAABwAAAAA+AAAAHwAAAHAAAAAHgAB8AAAAAAAAHgAAAAAAAAAAAAAAH///AAAAAAAABwAAAAA+AAAAHwAAAHAAAAAHgAD8AAAAAAAAHgAAAAAAAAAAAAAAH///AAAAAAAABwAAAAA+AAAAHwAAAHgAAAAPgAD8AAAAAAAAHgAAAAAAAAAfAAAAH///AAAAAAAABwAAAAA+AAAAHwAAAHgA8AAPwAD+AAAAAAAAHgAAAAAAAAD/8AAAH///AAAB8AAABwAAAAA+AAAAHwAAAHgH/gAPwAD+AAAAAAADngAAAAAAAAH//AAAH//+AAAH/wAABwAAAAA+AAAAHwAAAHgP/wAPwAD+AAAAAAAHjwAAAAAAAAP//gAAD/P+AAAf/8AAA4AAAAA+AAAAHwAAAHgP/wAP4AD+AAH+AAAHjwAAAAAAAAf//wAAD8D8AAA//+AAA4AAAAA+AAAADwAAAHgf/wAP4AD/AAf/AAAPjwAAAAAAAAf4f4AAD8D8AAA///AAA4AAAAA+AAAADwAAAHgf/wAf4AH/AA//AAAfjwAAAAAAAA/AD4AAD4D8AAB///gAA4AAAAA/AAAADwAAAHg//gAe8AHnAA//AAAfBwAAAAAAAA+AB8AAD4D4AAB8APwAA4AAAAA/AAAADwAAAHw+PgAecAHngB//AAA/B4AAAAAAAA+AA+AAB4D4AAD8ADwAA4AAAAA/AAAADwAAADw+PgAecAHngB//AAA/B4AAAAAAAA+AAfAAD4D4AAD4AB4AA4AAAAA/AAAADwAAADw8fAA8eAHDgB8fAAB+B4AAAAAAAA/AAfAAD4D4AAD4AB8AA4AAAAAfAAAADwAAADw8fAA8OAPDwB4+AAB+A8AAAAAAAA/gAPgAD4D4AAB8AA8AA8AAAAAfAAAADwAAADw++AA8PAPDwB4+AAD8A8AAAAAAAA/wAfgADwD4AAB+AA+AAcAAAAAfgAAADwAAADw/+AA8PAPBwB48AAD8A8AAAAAAAA/4A/gAHwD4AAB/AA+AAcAAAAAfgAAADwAAADw/8AB4HAfB4B58AAH4AeAAAAAAAA/+B/wAPwD4AAB/wB/AAcAAAAAfgAAADwAAADw/8AB4HgeB4B/8AAH4AeAAAAAAAB////wAfwD4AAD/4H/AA8AAAAAPgAAADwAAADwf8AB4HgeA4B/4AAP4AeAAAAAB8P////4A/wD8AAH////AD+AAAAAPwAAAD4AAADwf4AD4DgeA8B/4AAPwAPAAAAAB//////8D/gD+AAP////gH+AAAAAPwAAAD4AAAD4f4ADwDw+A8B/4AAfwAPAAAAAD/////////AB/wA/////wf+AAAAAH4AAAD4AAAD4/4ADwBw8AcB/wAAfgAHgAAAAD/////j//+AB//////////+AAAAAHwAAAB4AAAD7/8AHwB48AeA/wAA/gAHgAAAAH//gPwB//4AA//////+P///AAAAADwAAAB4AAAD///AHgB58AeB/wAA/AAHwAAAAH/4AAAA//gAAf///A/gH//vAAAAAAAAAAB4AAAD///8PgA98APD/wAA/AADwAAAAPwAAAAAP+AAAH//wAAAB/+PAAAAAAAAAAB4AAAB/4///gA/4APH/8AB+AAD4AAAAPwAAAAABgAAAB/+AAAAA/4HAAAAAAAAAAA4AAAB/wP//AAf4APP//gB+AAB4AAAAfgAAAAAAAAAAAAAAAAAAPAHgAAAAAAAAAAAAAAB/gD//AAf4AH/5/+B8AAA8AAAAfgAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAB/AAf/AAfwAH/w//78AAA+AAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AAH+AAPwAD/AP//4AAAfAAAB/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAA+AAPwAD+AB//4AAAPAAAB+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAHgAD8AAf9wAAAHwAAD+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAB4AAD8AAAAD4AAH8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAA4AAAAB8AAf4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AB/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf///gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH///AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAAAAAYAAAAAwYAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAIBAAAAAYAAAAAwYAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAMBgAAAAAAAAAAwAAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAMBgAAAAAAAAAAwAAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAMBgAAAAAAAAAAwAAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AfAZ4P4Pw/3+D8DeYPwAA8wYAYDB+AwwPwAAAAAAAAAAAAAAAAAAAAAAAAAAAABzg7wfcDAc4MBgHOD6Yc4AD3wYAYDDnAwwc4AAAAAAAAAAAAAAAAAAAAAAAAAAAADABgwcGDAwMMBgMDDgYAMADBwYAYGABgwwwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDBgMMBgYDDAYAEAGAwYAMGAAgwxgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDBgEMBgYBDAYH8AGAwYAMGA/gwxgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDB/8MBgf/DAYf8AGAwYAMMD/gwx/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDB/8MBgf/DAYYEAGAwYAGMDAgwx/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDBgAMBgYADAYwEAGAwYAGMGAgwxgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGADAYYGDBgAMBgYADAYwMAGAwYACYGBgwxgAAAAAAAAAAAAAAAAAAAAAAAAAAAAADABg4YGDAwAMBgMADAYwMADBwYADYGBgwwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgBwwYGDA4EMBgOBDAY4cADjwYADwHDgww4EAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/g/gYGDAf8Hw+H/DAYfkAB+wYABwD8gwwf8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAOAQCDADADweAwCAQGEAAYwQABgAwgggDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  var dispositivo = null;
  var caratteristica = null;

  // ── stato della pillola ──────────────────────────────────────────────
  function pillola() { return document.getElementById('stampanteToggle'); }

  function aggiornaPillola(stato, testo) {
    var el = pillola();
    if (!el) return;
    el.className = 'stampante-toggle ' + stato;
    var t = el.querySelector('.status-text');
    if (t) t.textContent = testo;
  }

  function connessa() {
    return !!(caratteristica && dispositivo && dispositivo.gatt && dispositivo.gatt.connected);
  }

  function avvisa(messaggio, tipo) {
    try {
      if (typeof sistemaOffline !== 'undefined' && sistemaOffline.mostraNotifica) {
        sistemaOffline.mostraNotifica(messaggio, 4000, tipo || 'warning');
        return;
      }
    } catch (e) {}
    console.warn('Stampante: ' + messaggio);
  }

  // ── formattazione del testo ──────────────────────────────────────────

  // La termica lavora su una tabella a un byte: le lettere accentate
  // arriverebbero come due byte UTF-8 e uscirebbero come due caratteri a
  // caso. Si tolgono gli accenti prima di spedire — "Perù" diventa "Peru",
  // che è brutto ma leggibile, mentre "PerÃ¹" non è nessuna delle due cose.
  function ascii(testo) {
    var s = String(testo == null ? '' : testo);
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
            .replace(/[–—]/g, '-').replace(/€/g, 'EUR')
            .replace(/[^\x20-\x7E]/g, '');
  }

  // Riga "sinistra ..... destra" giustificata sulle 32 colonne. Se le due
  // parti non ci stanno si lascia comunque uno spazio: meglio una riga che
  // sfora che due parole appiccicate.
  function lr(sinistra, destra) {
    var s = ascii(sinistra), d = ascii(destra);
    var spazi = Math.max(1, COLONNE - s.length - d.length);
    return s + new Array(spazi + 1).join(' ') + d;
  }

  // Il nome del prodotto sta da solo sulla sua riga e può essere lungo:
  // si manda a capo sulle parole, non a metà di una.
  function aCapo(testo, larghezza) {
    var parole = ascii(testo).split(/\s+/).filter(function (p) { return p.length; });
    var righe = [], corrente = '';
    parole.forEach(function (p) {
      while (p.length > larghezza) {          // parola più lunga della riga
        if (corrente) { righe.push(corrente); corrente = ''; }
        righe.push(p.slice(0, larghezza));
        p = p.slice(larghezza);
      }
      if (!corrente) corrente = p;
      else if (corrente.length + 1 + p.length <= larghezza) corrente += ' ' + p;
      else { righe.push(corrente); corrente = p; }
    });
    if (corrente) righe.push(corrente);
    return righe.length ? righe : [''];
  }

  function euro(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return v.toFixed(2).replace('.', ',');
  }

  // ── costruzione del buffer ESC/POS ───────────────────────────────────

  function b64ToBytes(b64) {
    var bin = atob(b64), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  function densita() {
    var d;
    try { d = parseInt(localStorage.getItem(DENSITA_CHIAVE), 10); } catch (e) {}
    if (!isFinite(d) || d < 0 || d > 15) d = DENSITA_DEFAULT;
    return d;
  }

  function costruisci(dati) {
    var pezzi = [];
    var enc = new TextEncoder();
    var push = function (x) { pezzi.push(x instanceof Uint8Array ? x : enc.encode(x)); };
    var grassetto = function (on) { push(new Uint8Array([ESC, 0x45, on ? 0x01 : 0x00])); };
    var centro = function () { push(new Uint8Array([ESC, 0x61, 0x01])); };
    var sinistra = function () { push(new Uint8Array([ESC, 0x61, 0x00])); };

    push(new Uint8Array([ESC, 0x40]));                  // init
    push(new Uint8Array([0x12, 0x23, densita()]));      // densità di stampa

    // Intestazione
    centro();
    push(b64ToBytes(LOGO_B64));
    push(new Uint8Array([LF]));
    grassetto(true);
    push("Az. Agr. Carbone\n");
    grassetto(false);
    // L'indirizzo su due righe: tutto di seguito fa 35 caratteri e la
    // stampante lo taglierebbe in mezzo alla provincia.
    push("Via Courtil 3\n");
    push("12020 Frassino (CN)\n");
    push("P.IVA 01614180626\n\n");

    grassetto(true);
    push("DOCUMENTO COMMERCIALE\n");
    grassetto(false);
    push("di vendita o prestazione\n\n");

    // Corpo
    sinistra();
    grassetto(true);
    push(lr("Descrizione", "Importo") + "\n");
    grassetto(false);

    (dati.righe || []).forEach(function (r) {
      // Nome del prodotto su riga sua, poi la sotto-riga rientrata con il
      // formato ("2 confezioni x 100g") e l'importo a destra.
      aCapo(r.nome, COLONNE).forEach(function (riga) { push(riga + "\n"); });
      push(lr("  " + (r.dettaglio || ''), euro(r.importo)) + "\n");
    });

    if (Number(dati.sconto) > 0) {
      push(lr("Sconto", "-" + euro(dati.sconto)) + "\n");
    }
    push("\n");

    // Totali. Sono quelli calcolati dal server e già certificati: qui non si
    // somma niente, si scrive.
    push(lr("Totale imponibile", euro(dati.imponibile)) + "\n");
    (dati.aliquote || []).forEach(function (a) {
      push(lr("Totale IVA " + a.aliquota + "%", euro(a.imposta)) + "\n");
    });
    grassetto(true);
    push(lr("TOTALE COMPLESSIVO", "EUR " + euro(dati.totale)) + "\n");
    grassetto(false);
    push(lr("Pagato " + (dati.contante ? "contante" : "elettronico"), euro(dati.totale)) + "\n\n");

    // Estremi del documento fiscale a cui questa carta si riferisce
    centro();
    if (dati.progressivo) push("Documento N. " + ascii(dati.progressivo) + "\n");
    if (dati.dataOra) push("del " + ascii(dati.dataOra) + "\n");
    push("\n");

    grassetto(true);
    push("Butta questo scontrino nella\n");
    push("carta, e' riciclabile!\n");
    grassetto(false);
    push(new Uint8Array([LF, LF, LF, LF]));             // avanza la carta

    var tot = 0;
    pezzi.forEach(function (p) { tot += p.length; });
    var buf = new Uint8Array(tot), o = 0;
    pezzi.forEach(function (p) { buf.set(p, o); o += p.length; });
    return buf;
  }

  // Saluto del mattino: appena la stampante è agganciata sputa una riga.
  // Serve a due cose in una — si vede subito che il collegamento regge
  // davvero (la pillola diventa verde anche se poi la carta è finita o la
  // densità è troppo bassa) e si controlla a occhio come stampa prima di
  // avere un cliente al banco. Se non esce niente, c'è qualcosa da sistemare
  // adesso, non alla prima vendita.
  function saluto() {
    var pezzi = [];
    var enc = new TextEncoder();
    var push = function (x) { pezzi.push(x instanceof Uint8Array ? x : enc.encode(x)); };
    push(new Uint8Array([ESC, 0x40]));
    push(new Uint8Array([0x12, 0x23, densita()]));
    push(new Uint8Array([ESC, 0x61, 0x01]));           // centro
    push(new Uint8Array([ESC, 0x45, 0x01]));           // grassetto
    push("Buongiorno Principessa\n");
    push(new Uint8Array([ESC, 0x45, 0x00]));
    push(new Uint8Array([LF, LF, LF]));
    var tot = 0;
    pezzi.forEach(function (p) { tot += p.length; });
    var buf = new Uint8Array(tot), o = 0;
    pezzi.forEach(function (p) { buf.set(p, o); o += p.length; });
    return buf;
  }

  // ── invio ────────────────────────────────────────────────────────────

  // A blocchi di 100 byte con 40ms di pausa. La PT-210 non ha coda: se le si
  // rovescia addosso il buffer intero perde pezzi a metà scontrino.
  function invia(buf) {
    var CHUNK = 100;
    var i = 0;
    function passo() {
      if (i >= buf.length) return Promise.resolve();
      var fetta = buf.slice(i, i + CHUNK);
      i += CHUNK;
      var scrittura = caratteristica.properties && caratteristica.properties.writeWithoutResponse
        ? caratteristica.writeValueWithoutResponse(fetta)
        : caratteristica.writeValue(fetta);
      return scrittura.then(function () {
        return new Promise(function (r) { setTimeout(r, 40); });
      }).then(passo);
    }
    return passo();
  }

  // ── connessione ──────────────────────────────────────────────────────

  function scollega() {
    caratteristica = null;
    aggiornaPillola('assente', 'Stampante');
  }

  function connetti() {
    if (!navigator.bluetooth) {
      // Può dipendere dal browser (Safari e Chrome per iOS non lo hanno) o
      // dalla pagina che ci contiene. In entrambi i casi da qui non si apre
      // niente, e non serve mandare l'operatrice a frugare nelle impostazioni.
      avvisa('Bluetooth non disponibile in questa pagina', 'error');
      return Promise.resolve(false);
    }
    aggiornaPillola('attesa', 'Cerco...');
    return navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVIZIO]
    }).then(function (d) {
      dispositivo = d;
      // Se la stampante si spegne o esce dal raggio, la pillola torna grigia
      // da sola: così non si scopre che era caduta al primo scontrino perso.
      dispositivo.addEventListener('gattserverdisconnected', scollega);
      return dispositivo.gatt.connect();
    }).then(function (server) {
      return server.getPrimaryService(SERVIZIO);
    }).then(function (s) {
      return s.getCharacteristic(CARATTERISTICA);
    }).then(function (c) {
      caratteristica = c;
      aggiornaPillola('connessa', 'Stampante');
      avvisa('Stampante collegata', 'success');
      // Il saluto è in coda alla connessione, non davanti: se la carta è
      // finita la stampante resta collegata lo stesso e la giornata parte.
      return invia(saluto()).catch(function (e) {
        console.error('Saluto non stampato:', e);
      }).then(function () { return true; });
    }).catch(function (e) {
      console.error('Stampante non collegata:', e);
      scollega();
      // requestDevice rifiutata dall'operatrice: non è un guasto, non si urla.
      if (!(e && e.name === 'NotFoundError')) avvisa('Stampante non collegata', 'error');
      return false;
    });
  }

  function alterna() {
    if (connessa()) {
      try { dispositivo.gatt.disconnect(); } catch (e) {}
      scollega();
      avvisa('Stampante scollegata', 'info');
      return;
    }
    connetti();
  }

  // ── stampa di uno scontrino ──────────────────────────────────────────

  // Chiamata dal gestore della risposta di salvaDati. `dati` è risposta.stampa:
  // arriva solo per i Privati e solo se lo scontrino fiscale è stato emesso.
  function stampa(dati) {
    if (!dati || !dati.righe || !dati.righe.length) return Promise.resolve(false);
    if (!connessa()) {
      avvisa('Stampante non connessa, scontrino non stampato', 'warning');
      return Promise.resolve(false);
    }
    var buf;
    try {
      buf = costruisci(dati);
    } catch (e) {
      console.error('Scontrino non composto:', e);
      avvisa('Scontrino non stampato', 'warning');
      return Promise.resolve(false);
    }
    return invia(buf).then(function () {
      return true;
    }).catch(function (e) {
      console.error('Scontrino non stampato:', e);
      // Una scrittura fallita di solito vuol dire connessione caduta.
      if (!connessa()) scollega();
      avvisa('Stampante non ha risposto, scontrino non stampato', 'warning');
      return false;
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var el = pillola();
    if (!el) return;
    el.addEventListener('click', alterna);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alterna(); }
    });
    // Niente Web Bluetooth in questa pagina: pillola rossa con scritto
    // «Bluetooth», che è la cosa che manca. «No BT» si leggeva come "il
    // Bluetooth è spento", e mandava a cercare un interruttore che non c'entra.
    if (!navigator.bluetooth) aggiornaPillola('nonDisponibile', 'Bluetooth');
  });

  // Superficie pubblica: la stampa la chiama il gestore della vendita,
  // il resto serve per tarare la stampante dalla console del tablet.
  window.stampante = {
    stampa: stampa,
    connetti: connetti,
    connessa: connessa,
    densita: function (n) {
      if (n === undefined) return densita();
      try { localStorage.setItem(DENSITA_CHIAVE, String(n)); } catch (e) {}
      return densita();
    },
    // Scontrino di prova con i dati finti, per regolare la densità senza
    // dover vendere qualcosa.
    prova: function () {
      return stampa({
        righe: [
          { nome: 'Ghiaie', dettaglio: '2 confezioni x 100g', importo: 14 },
          { nome: 'Sassolini del Varaita', dettaglio: '1 confezione x 100g', importo: 7 },
          { nome: 'Nibs', dettaglio: 'sfuso 100g', importo: 3.5 }
        ],
        sconto: 0, imponibile: 22.27,
        aliquote: [{ aliquota: 10, imponibile: 22.27, imposta: 2.23 }],
        totale: 24.5, contante: true,
        progressivo: 'PROVA', dataOra: 'prova di stampa'
      });
    }
  };
})();

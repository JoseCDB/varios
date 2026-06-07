/* =========================================================================
 * Generador de Exámenes · Operador de Informática UVa
 * App estática (vanilla JS). Datos en window.BANCO y window.CONFIG.
 * ========================================================================= */
(function () {
  'use strict';

  const BANCO = window.BANCO || [];
  const CONFIG = window.CONFIG || {};
  const TEMAS = CONFIG.temas || {};
  const DIST = CONFIG.distribucionExamen || {};
  const EX = CONFIG.examen || { totalPreguntas: 80, opciones: 4, tiempoMinutos: 90, aciertoSuma: 1, falloResta: 0.33 };

  // ----- Estado -----
  let modo = null;                 // 'real' | 'rapido' | 'temas'
  let examen = [];                 // preguntas del examen actual (con orden de opciones)
  let respuestas = {};             // qid -> letra elegida (original)
  let timerId = null;
  let segundosRestantes = 0;

  // ----- Utilidades -----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const LETRAS = ['a', 'b', 'c', 'd', 'e', 'f'];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function temaTitulo(t) {
    const info = TEMAS[t] || TEMAS[String(t)];
    return info ? `Tema ${t}. ${info.titulo}` : `Tema ${t}`;
  }

  function inventarioPorTema() {
    const inv = {};
    BANCO.forEach(q => { inv[q.tema] = (inv[q.tema] || 0) + 1; });
    return inv;
  }
  const INV = inventarioPorTema();

  // =======================================================================
  // INICIO: render info banco + selector de temas
  // =======================================================================
  function initHome() {
    const totalTemas = Object.keys(TEMAS).length;
    $('#bank-info').innerHTML =
      `<strong>${BANCO.length}</strong> preguntas · ${totalTemas} temas<br>Funciona sin conexión`;

    // Selector de temas
    const grid = $('#temas-grid');
    grid.innerHTML = '';
    for (let t = 1; t <= 30; t++) {
      const count = INV[t] || 0;
      const thin = count < 8;
      const info = TEMAS[t] || TEMAS[String(t)] || { titulo: '', bloque: t <= 6 ? 1 : 2 };
      const label = document.createElement('label');
      label.className = 'tema-check' + (thin ? ' thin' : '');
      label.innerHTML =
        `<input type="checkbox" class="tema-cb" value="${t}" data-bloque="${info.bloque}" ${count ? 'checked' : ''} ${count ? '' : 'disabled'}>
         <span class="t-num">T${t}</span>
         <span class="t-name">${info.titulo}</span>
         <span class="t-count">${count} pre${thin ? ' ⚠' : ''}</span>`;
      grid.appendChild(label);
    }

    // Listeners de modos
    $$('.mode-card').forEach(card => {
      card.addEventListener('click', () => abrirConfig(card.dataset.modo));
    });
    $('#config-close').addEventListener('click', cerrarConfig);

    // Acciones selección de temas
    $('#sel-all').addEventListener('click', () => setTemas(() => true));
    $('#sel-none').addEventListener('click', () => setTemas(() => false));
    $('#sel-b1').addEventListener('click', () => setTemas(cb => cb.dataset.bloque === '1'));
    $('#sel-b2').addEventListener('click', () => setTemas(cb => cb.dataset.bloque === '2'));
    $$('.tema-cb').forEach(cb => cb.addEventListener('change', actualizarResumen));
    $('#cfg-count').addEventListener('change', actualizarResumen);

    $('#start-exam').addEventListener('click', comenzarExamen);
    $('#review-btn').addEventListener('click', mostrarRevision);
    $('#new-exam-btn').addEventListener('click', volverInicio);
    $('#finish-exam').addEventListener('click', corregirExamen);
    $('#abandon-exam').addEventListener('click', () => {
      if (confirm('¿Seguro que quieres abandonar el examen? Se perderán las respuestas.')) volverInicio();
    });
  }

  function setTemas(pred) {
    $$('.tema-cb').forEach(cb => { if (!cb.disabled) cb.checked = pred(cb); });
    actualizarResumen();
  }

  function temasSeleccionados() {
    return $$('.tema-cb').filter(cb => cb.checked && !cb.disabled).map(cb => Number(cb.value));
  }

  // =======================================================================
  // CONFIGURACIÓN
  // =======================================================================
  function abrirConfig(m) {
    modo = m;
    $$('.mode-card').forEach(c => c.classList.toggle('active', c.dataset.modo === m));
    const panel = $('#config-panel');
    panel.classList.remove('hidden');

    const titulos = { real: 'Examen real (formato convocatoria)', rapido: 'Examen rápido', temas: 'Examen por temas' };
    $('#config-title').textContent = titulos[m];

    // Mostrar/ocultar filas según modo
    $('#row-count').classList.toggle('hidden', m === 'real');
    $('#row-temas').classList.toggle('hidden', m !== 'temas');
    $('#row-timer').classList.toggle('hidden', m === 'real');

    if (m === 'temas') setTemas(() => true);
    if (m === 'rapido') setTemas(() => true);

    actualizarResumen();
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cerrarConfig() {
    $('#config-panel').classList.add('hidden');
    $$('.mode-card').forEach(c => c.classList.remove('active'));
    modo = null;
  }

  function actualizarResumen() {
    const sum = $('#config-summary');
    if (modo === 'real') {
      sum.textContent = `${EX.totalPreguntas} preguntas · ${EX.tiempoMinutos} min · distribución por temas histórica`;
      return;
    }
    const n = Number($('#cfg-count').value);
    if (modo === 'temas') {
      const temas = temasSeleccionados();
      const disp = temas.reduce((s, t) => s + (INV[t] || 0), 0);
      sum.textContent = `${temas.length} temas · ${Math.min(n, disp)} de ${n} preguntas (disponibles: ${disp})`;
    } else {
      sum.textContent = `${n} preguntas aleatorias de todo el temario`;
    }
  }

  // =======================================================================
  // GENERACIÓN DEL EXAMEN
  // =======================================================================
  function tomarAleatorias(pool, n, excluidasIds) {
    const disponibles = shuffle(pool.filter(q => !excluidasIds.has(q.id)));
    return disponibles.slice(0, n);
  }

  function construirExamen() {
    const barajarOpts = $('#cfg-shuffle-opts').checked;
    let seleccion = [];
    const usadas = new Set();

    if (modo === 'real') {
      // Distribución por tema según histórico; redondea y completa hasta el total.
      const objetivo = EX.totalPreguntas;
      // 1) por tema según distribución
      for (let t = 1; t <= 30; t++) {
        const cuota = Math.round(DIST[t] || 0);
        if (cuota <= 0) continue;
        const pool = BANCO.filter(q => q.tema === t);
        const elegidas = tomarAleatorias(pool, cuota, usadas);
        elegidas.forEach(q => usadas.add(q.id));
        seleccion = seleccion.concat(elegidas);
      }
      // 2) completar/recortar al objetivo
      if (seleccion.length > objetivo) {
        seleccion = shuffle(seleccion).slice(0, objetivo);
      } else if (seleccion.length < objetivo) {
        const resto = tomarAleatorias(BANCO, objetivo - seleccion.length, usadas);
        seleccion = seleccion.concat(resto);
      }
      seleccion = shuffle(seleccion);
    } else {
      const n = Number($('#cfg-count').value);
      let pool = BANCO;
      if (modo === 'temas') {
        const temas = temasSeleccionados();
        pool = BANCO.filter(q => temas.includes(q.tema));
      }
      seleccion = tomarAleatorias(pool, n, usadas);
    }

    // Preparar cada pregunta con orden de opciones
    return seleccion.map(q => {
      const claves = Object.keys(q.opciones);
      const orden = barajarOpts ? shuffle(claves) : claves;
      return { ref: q, orden };
    });
  }

  function comenzarExamen() {
    if (modo === 'temas' && temasSeleccionados().length === 0) {
      alert('Selecciona al menos un tema.');
      return;
    }
    examen = construirExamen();
    if (examen.length === 0) { alert('No hay preguntas disponibles con esa configuración.'); return; }
    respuestas = {};
    renderExamen();
    cambiarVista('exam');

    // Cronómetro
    stopTimer();
    const conTimer = (modo === 'real') || $('#cfg-timer').checked;
    if (conTimer) {
      const min = modo === 'real' ? EX.tiempoMinutos : Math.max(1, Math.round(examen.length * 1.1));
      iniciarTimer(min * 60);
    } else {
      $('#timer').classList.add('hidden');
    }
    window.scrollTo(0, 0);
  }

  // =======================================================================
  // RENDER EXAMEN
  // =======================================================================
  function renderExamen() {
    const cont = $('#questions-container');
    cont.innerHTML = '';
    examen.forEach((item, i) => cont.appendChild(renderPregunta(item, i, false)));

    $('#total-count').textContent = examen.length;
    renderPalette();
    actualizarProgreso();
  }

  function renderPregunta(item, idx, revision) {
    const q = item.ref;
    const card = document.createElement('div');
    card.className = 'q-card';
    card.id = `q-${idx}`;

    const head = document.createElement('div');
    head.className = 'q-head';
    head.innerHTML = `<span class="q-num">${idx + 1}</span>
      <span class="q-tema-tag">${revision ? temaTitulo(q.tema) : 'Tema ' + q.tema}</span>`;
    card.appendChild(head);

    const texto = document.createElement('div');
    texto.className = 'q-text';
    texto.textContent = q.pregunta;
    card.appendChild(texto);

    const opts = document.createElement('div');
    opts.className = 'options';
    item.orden.forEach((claveOrig, pos) => {
      const letraVis = LETRAS[pos];
      const opt = document.createElement('label');
      opt.className = 'option';
      opt.dataset.clave = claveOrig;

      const elegido = respuestas[q.id] === claveOrig;
      if (!revision && elegido) opt.classList.add('selected');

      if (revision) {
        const esCorrecta = claveOrig === q.respuesta;
        const esElegida = respuestas[q.id] === claveOrig;
        if (esCorrecta) opt.classList.add('correct');
        else if (esElegida) opt.classList.add('incorrect');
      }

      opt.innerHTML = `<span class="opt-letter">${letraVis})</span>
        <span class="opt-text">${escapeHtml(q.opciones[claveOrig])}</span>`;

      if (revision) {
        if (claveOrig === q.respuesta) opt.innerHTML += `<span class="mark">✓ correcta</span>`;
        else if (respuestas[q.id] === claveOrig) opt.innerHTML += `<span class="mark">✗ tu respuesta</span>`;
      } else {
        opt.addEventListener('click', () => seleccionar(q.id, claveOrig, idx));
      }
      opts.appendChild(opt);
    });
    card.appendChild(opts);

    if (revision) {
      const exp = document.createElement('div');
      exp.className = 'explanation';
      if (q.explicacion) {
        exp.innerHTML = `<strong>Explicación:</strong> ${escapeHtml(q.explicacion)}
          <span class="exp-tema">📚 ${temaTitulo(q.tema)}</span>`;
      } else {
        exp.innerHTML = `<span class="no-exp">Sin explicación detallada para esta pregunta.</span>
          <span class="exp-tema">📚 ${temaTitulo(q.tema)} · Respuesta correcta: ${q.respuesta.toUpperCase()}) ${escapeHtml(q.opciones[q.respuesta])}</span>`;
      }
      card.appendChild(exp);
    }
    return card;
  }

  function seleccionar(qid, clave, idx) {
    respuestas[qid] = clave;
    const card = $(`#q-${idx}`);
    $$('.option', card).forEach(o => o.classList.toggle('selected', o.dataset.clave === clave));
    renderPalette();
    actualizarProgreso();
  }

  function renderPalette() {
    const pal = $('#palette');
    pal.innerHTML = '';
    examen.forEach((item, i) => {
      const b = document.createElement('button');
      b.textContent = i + 1;
      if (respuestas[item.ref.id]) b.classList.add('answered');
      b.addEventListener('click', () => {
        $(`#q-${i}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      pal.appendChild(b);
    });
  }

  function actualizarProgreso() {
    const respondidas = examen.filter(it => respuestas[it.ref.id]).length;
    $('#answered-count').textContent = respondidas;
    $('#progress-fill').style.width = (respondidas / examen.length * 100) + '%';
  }

  // =======================================================================
  // CRONÓMETRO
  // =======================================================================
  function iniciarTimer(seg) {
    segundosRestantes = seg;
    $('#timer').classList.remove('hidden');
    pintarTimer();
    timerId = setInterval(() => {
      segundosRestantes--;
      pintarTimer();
      if (segundosRestantes <= 0) {
        stopTimer();
        alert('Se acabó el tiempo. Se corregirá el examen.');
        corregirExamen();
      }
    }, 1000);
  }
  function pintarTimer() {
    const m = Math.floor(segundosRestantes / 60);
    const s = segundosRestantes % 60;
    $('#timer-val').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('#timer').classList.toggle('danger', segundosRestantes <= 60);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  // =======================================================================
  // CORRECCIÓN / RESULTADOS
  // =======================================================================
  function corregirExamen() {
    const sinResponder = examen.length - examen.filter(it => respuestas[it.ref.id]).length;
    if (sinResponder > 0 && segundosRestantes > 0) {
      if (!confirm(`Tienes ${sinResponder} preguntas sin responder. ¿Corregir de todas formas?`)) return;
    }
    stopTimer();

    let ok = 0, bad = 0, blank = 0;
    const porTema = {};
    examen.forEach(it => {
      const q = it.ref;
      const r = respuestas[q.id];
      porTema[q.tema] = porTema[q.tema] || { ok: 0, total: 0 };
      porTema[q.tema].total++;
      if (!r) blank++;
      else if (r === q.respuesta) { ok++; porTema[q.tema].ok++; }
      else bad++;
    });

    const nota = Math.max(0, ok * EX.aciertoSuma - bad * EX.falloResta);
    const pct = Math.round(ok / examen.length * 100);

    $('#r-ok').textContent = ok;
    $('#r-bad').textContent = bad;
    $('#r-blank').textContent = blank;
    $('#r-nota').textContent = nota.toFixed(2) + ' / ' + (examen.length * EX.aciertoSuma);

    const circle = $('#score-circle');
    $('#score-pct').textContent = pct + '%';
    circle.className = 'score-circle ' + (pct >= 70 ? 'good' : pct >= 50 ? 'mid' : 'bad');
    $('#score-grade').textContent = pct >= 70 ? 'Aprobado' : pct >= 50 ? 'Casi' : 'A repasar';

    renderTemaStats(porTema);
    $('#review-container').innerHTML = '';
    cambiarVista('results');
    window.scrollTo(0, 0);
  }

  function renderTemaStats(porTema) {
    const cont = $('#tema-stats');
    cont.innerHTML = '';
    Object.keys(porTema).map(Number).sort((a, b) => a - b).forEach(t => {
      const d = porTema[t];
      const pct = Math.round(d.ok / d.total * 100);
      const row = document.createElement('div');
      row.className = 'tema-stat-row';
      row.innerHTML = `<span class="ts-label">T${t} · ${(TEMAS[t] || {}).titulo || ''}</span>
        <span class="ts-bar"><span class="ts-fill" style="width:${pct}%"></span></span>
        <span class="ts-num">${d.ok}/${d.total}</span>`;
      cont.appendChild(row);
    });
  }

  function mostrarRevision() {
    const cont = $('#review-container');
    if (cont.children.length) { cont.scrollIntoView({ behavior: 'smooth' }); return; }
    const h = document.createElement('h3');
    h.textContent = 'Corrección detallada';
    cont.appendChild(h);
    examen.forEach((item, i) => cont.appendChild(renderPregunta(item, i, true)));
    cont.scrollIntoView({ behavior: 'smooth' });
  }

  // =======================================================================
  // NAVEGACIÓN DE VISTAS
  // =======================================================================
  function cambiarVista(v) {
    ['home', 'exam', 'results'].forEach(name => {
      $('#view-' + name).classList.toggle('hidden', name !== v);
    });
  }

  function volverInicio() {
    stopTimer();
    examen = []; respuestas = {};
    cerrarConfig();
    cambiarVista('home');
    window.scrollTo(0, 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ----- Arranque -----
  if (!BANCO.length) {
    document.getElementById('bank-info').textContent = '⚠ No se pudo cargar el banco de preguntas';
  }
  initHome();
})();

/* =========================================================================
 * Generador de Exámenes · Operador de Informática UVa
 * App estática (vanilla JS). Datos en window.BANCO y window.CONFIG.
 * Persistencia ligera en localStorage (sin servidor ni BBDD):
 *   opos.enCurso   -> examen a medio hacer (para reanudar tras recarga)
 *   opos.historial -> últimos 50 resultados
 *   opos.falladas  -> ids de preguntas falladas pendientes de dominar
 *   opos.vistas    -> ids ya aparecidas (para no repetir entre exámenes)
 * ========================================================================= */
(function () {
  'use strict';

  const BANCO = window.BANCO || [];
  const CONFIG = window.CONFIG || {};
  const TEMAS = CONFIG.temas || {};
  const DIST = CONFIG.distribucionExamen || {};
  const EX = CONFIG.examen || { totalPreguntas: 80, preguntasReserva: 8, opciones: 4, tiempoMinutos: 90, aciertoSuma: 1, falloResta: 0.33 };
  const POR_ID = new Map(BANCO.map(q => [q.id, q]));

  // ----- Estado -----
  let modo = null;                 // 'real' | 'rapido' | 'temas' | 'falladas'
  let examen = [];                 // [{ref, orden, reserva}]
  let respuestas = {};             // qid -> letra elegida (clave original)
  let timerId = null;
  let segundosRestantes = 0;
  let idxActual = 0;               // pregunta visible (paleta/teclado)
  let observer = null;

  // ----- Utilidades -----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const LETRAS = ['a', 'b', 'c', 'd', 'e', 'f'];

  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado o cuota */ } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };

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

  // Origen de la pregunta (para la revisión)
  function origenTag(q) {
    if (/^E22/.test(q.id)) return 'Examen oficial 2022';
    if (/^E23/.test(q.id)) return 'Examen oficial 2023';
    if (/^E24/.test(q.id)) return 'Examen oficial 2024';
    if (/^X26/.test(q.id)) return 'Examen oficial 2026';
    if (q.origen === 'oficial') return 'Examen oficial';
    if (q.origen === 'estudio') return 'Redactada del temario 2026';
    return '';
  }

  function inventarioPorTema() {
    const inv = {};
    BANCO.forEach(q => { inv[q.tema] = (inv[q.tema] || 0) + 1; });
    return inv;
  }
  const INV = inventarioPorTema();

  const falladasSet = () => new Set(LS.get('opos.falladas', []));

  // =======================================================================
  // INICIO: render info banco + selector de temas + progreso + reanudar
  // =======================================================================
  function initHome() {
    const totalTemas = Object.keys(TEMAS).length;
    $('#bank-info').innerHTML =
      `<strong>${BANCO.length}</strong> preguntas · ${totalTemas} temas<br>Datos locales · sin servidor`;

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
    $('#retry-failed-btn').addEventListener('click', repetirFalladasExamen);
    $('#finish-exam').addEventListener('click', () => corregirExamen(false));
    $('#abandon-exam').addEventListener('click', () => {
      if (confirm('¿Seguro que quieres abandonar el examen? Se perderán las respuestas.')) {
        limpiarEnCurso();
        volverInicio();
      }
    });

    // Historial
    $('#clear-history').addEventListener('click', () => {
      if (confirm('¿Borrar todo el progreso guardado (historial y falladas)? Esta acción no se puede deshacer.')) {
        LS.del('opos.historial'); LS.del('opos.falladas'); LS.del('opos.vistas');
        refrescarHome();
      }
    });

    // Reanudar examen guardado
    $('#resume-yes').addEventListener('click', reanudarExamen);
    $('#resume-no').addEventListener('click', () => { limpiarEnCurso(); refrescarHome(); });

    // Teclado
    document.addEventListener('keydown', onKeydown);

    // Guardado ante cierre/recarga
    window.addEventListener('beforeunload', guardarEnCurso);
    document.addEventListener('visibilitychange', () => { if (document.hidden) guardarEnCurso(); });

    refrescarHome();
  }

  function refrescarHome() {
    // Tarjeta modo falladas
    const nFall = falladasSet().size;
    const cardFall = $('.mode-card[data-modo="falladas"]');
    cardFall.classList.toggle('hidden', nFall === 0);
    $('#falladas-count').textContent = nFall;

    // Barra de reanudar
    const data = LS.get('opos.enCurso', null);
    const bar = $('#resume-bar');
    const valido = data && Array.isArray(data.ids) && data.ids.length && data.ids.some(id => POR_ID.has(id));
    if (valido) {
      const resp = Object.keys(data.respuestas || {}).length;
      $('#resume-text').textContent =
        `Tienes un examen a medio hacer (${resp}/${data.ids.length} respondidas${data.seg != null ? ', con cronómetro' : ''}).`;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
      if (data) limpiarEnCurso();
    }

    renderHistorial();
  }

  function renderHistorial() {
    const hist = LS.get('opos.historial', []);
    const card = $('#history-card');
    card.classList.toggle('hidden', hist.length === 0);
    if (!hist.length) return;

    const nombres = { real: 'Real', rapido: 'Rápido', temas: 'Por temas', falladas: 'Falladas' };
    const list = $('#history-list');
    list.innerHTML = '';
    hist.slice(0, 6).forEach(h => {
      const d = new Date(h.f);
      const fecha = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const cls = h.nota10 >= 5 ? 'good' : h.nota10 >= 4 ? 'mid' : 'bad';
      const row = document.createElement('div');
      row.className = 'hist-row';
      row.innerHTML = `<span class="h-fecha">${fecha}</span>
        <span class="h-modo">${nombres[h.modo] || h.modo} · ${h.n} preg</span>
        <span class="h-detalle">${h.ok}✓ ${h.bad}✗ ${h.blank}·</span>
        <span class="h-nota ${cls}">${h.nota10.toFixed(2)}/10</span>`;
      list.appendChild(row);
    });

    // Peores temas acumulados (mínimo 6 preguntas vistas del tema)
    const acum = {};
    hist.forEach(h => {
      Object.entries(h.porTema || {}).forEach(([t, d]) => {
        acum[t] = acum[t] || { ok: 0, total: 0 };
        acum[t].ok += d.ok; acum[t].total += d.total;
      });
    });
    const peores = Object.entries(acum)
      .filter(([, d]) => d.total >= 6)
      .map(([t, d]) => ({ t: Number(t), pct: d.ok / d.total, d }))
      .sort((a, b) => a.pct - b.pct)
      .slice(0, 3);
    const cont = $('#worst-temas');
    cont.innerHTML = '';
    if (peores.length) {
      cont.innerHTML = '<span class="muted">Temas que más fallas:</span> ' + peores
        .map(p => `<span class="worst-tag">T${p.t} (${Math.round(p.pct * 100)}% · ${p.d.ok}/${p.d.total})</span>`).join(' ');
    }
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

    const titulos = { real: 'Examen real (formato convocatoria)', rapido: 'Examen rápido', temas: 'Examen por temas', falladas: 'Repaso de falladas' };
    $('#config-title').textContent = titulos[m];

    // Mostrar/ocultar filas según modo
    $('#row-count').classList.toggle('hidden', m === 'real');
    $('#row-temas').classList.toggle('hidden', m !== 'temas');
    $('#row-timer').classList.toggle('hidden', m === 'real');
    $('#row-reserva').classList.toggle('hidden', m !== 'real');

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
    } else if (modo === 'falladas') {
      const disp = falladasSet().size;
      sum.textContent = `${Math.min(n, disp)} de tus ${disp} preguntas falladas pendientes`;
    } else {
      sum.textContent = `${n} preguntas aleatorias de todo el temario`;
    }
  }

  // =======================================================================
  // GENERACIÓN DEL EXAMEN (prefiere preguntas aún no vistas)
  // =======================================================================
  function tomarAleatorias(pool, n, excluidasIds, preferirNuevas = true) {
    const cand = pool.filter(q => !excluidasIds.has(q.id));
    if (!preferirNuevas) return shuffle(cand).slice(0, n);
    const vistas = new Set(LS.get('opos.vistas', []));
    const nuevas = shuffle(cand.filter(q => !vistas.has(q.id)));
    if (nuevas.length >= n) return nuevas.slice(0, n);
    const repetidas = shuffle(cand.filter(q => vistas.has(q.id)));
    return nuevas.concat(repetidas.slice(0, n - nuevas.length));
  }

  function registrarVistas(ids) {
    let vistas = LS.get('opos.vistas', []);
    const set = new Set(vistas);
    ids.forEach(id => set.add(id));
    // Ciclo completo: cuando casi todo el banco está visto, se reinicia el contador
    if (set.size >= BANCO.length * 0.9) {
      LS.set('opos.vistas', ids.slice());
    } else {
      LS.set('opos.vistas', Array.from(set));
    }
  }

  function construirExamen() {
    const barajarOpts = $('#cfg-shuffle-opts').checked;
    let seleccion = [];
    let reserva = [];
    const usadas = new Set();

    if (modo === 'real') {
      const objetivo = EX.totalPreguntas;
      for (let t = 1; t <= 30; t++) {
        const cuota = Math.round(DIST[t] || 0);
        if (cuota <= 0) continue;
        const pool = BANCO.filter(q => q.tema === t);
        const elegidas = tomarAleatorias(pool, cuota, usadas);
        elegidas.forEach(q => usadas.add(q.id));
        seleccion = seleccion.concat(elegidas);
      }
      if (seleccion.length > objetivo) {
        seleccion = shuffle(seleccion).slice(0, objetivo);
      } else if (seleccion.length < objetivo) {
        const resto = tomarAleatorias(BANCO, objetivo - seleccion.length, usadas);
        resto.forEach(q => usadas.add(q.id));
        seleccion = seleccion.concat(resto);
      }
      seleccion = shuffle(seleccion);
      // Preguntas de reserva (como en la convocatoria: 8 extra al final)
      if ($('#cfg-reserva').checked) {
        seleccion.forEach(q => usadas.add(q.id));
        reserva = tomarAleatorias(BANCO, EX.preguntasReserva || 8, usadas);
      }
    } else if (modo === 'falladas') {
      const n = Number($('#cfg-count').value);
      const set = falladasSet();
      const pool = BANCO.filter(q => set.has(q.id));
      seleccion = tomarAleatorias(pool, n, usadas, false);
    } else {
      const n = Number($('#cfg-count').value);
      let pool = BANCO;
      if (modo === 'temas') {
        const temas = temasSeleccionados();
        pool = BANCO.filter(q => temas.includes(q.tema));
      }
      seleccion = tomarAleatorias(pool, n, usadas);
    }

    const prep = q => {
      const claves = Object.keys(q.opciones);
      const orden = barajarOpts ? shuffle(claves) : claves;
      return { ref: q, orden, reserva: false };
    };
    const items = seleccion.map(prep).concat(reserva.map(q => Object.assign(prep(q), { reserva: true })));
    if (modo !== 'falladas') registrarVistas(items.map(it => it.ref.id));
    return items;
  }

  function comenzarExamen() {
    if (modo === 'temas' && temasSeleccionados().length === 0) {
      alert('Selecciona al menos un tema.');
      return;
    }
    examen = construirExamen();
    if (examen.length === 0) { alert('No hay preguntas disponibles con esa configuración.'); return; }
    respuestas = {};
    idxActual = 0;
    renderExamen();
    cambiarVista('exam');

    // Cronómetro
    stopTimer();
    segundosRestantes = 0;
    const conTimer = (modo === 'real') || $('#cfg-timer').checked;
    if (conTimer) {
      const nPrincipales = examen.filter(it => !it.reserva).length;
      const min = modo === 'real' ? EX.tiempoMinutos : Math.max(1, Math.round(nPrincipales * 1.1));
      iniciarTimer(min * 60);
    } else {
      $('#timer').classList.add('hidden');
    }
    guardarEnCurso();
    window.scrollTo(0, 0);
  }

  // =======================================================================
  // PERSISTENCIA DEL EXAMEN EN CURSO (localStorage)
  // =======================================================================
  function guardarEnCurso() {
    if (!examen.length || $('#view-exam').classList.contains('hidden')) return;
    LS.set('opos.enCurso', {
      modo,
      ts: Date.now(),
      ids: examen.map(it => it.ref.id),
      orden: Object.fromEntries(examen.map(it => [it.ref.id, it.orden])),
      reservaIds: examen.filter(it => it.reserva).map(it => it.ref.id),
      respuestas,
      seg: timerId ? segundosRestantes : null,
    });
  }

  function limpiarEnCurso() { LS.del('opos.enCurso'); }

  function reanudarExamen() {
    const data = LS.get('opos.enCurso', null);
    if (!data || !Array.isArray(data.ids)) { refrescarHome(); return; }
    const reservaIds = new Set(data.reservaIds || []);
    examen = data.ids
      .map(id => POR_ID.get(id))
      .filter(Boolean)
      .map(q => ({
        ref: q,
        orden: (data.orden && data.orden[q.id]) || Object.keys(q.opciones),
        reserva: reservaIds.has(q.id),
      }));
    if (!examen.length) { limpiarEnCurso(); refrescarHome(); return; }
    respuestas = data.respuestas || {};
    modo = data.modo || 'rapido';
    idxActual = 0;
    renderExamen();
    cambiarVista('exam');
    stopTimer();
    if (data.seg != null && data.seg > 0) iniciarTimer(data.seg);
    else $('#timer').classList.add('hidden');
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
    observarPreguntaActual();
  }

  function numeroVisible(idx) {
    const item = examen[idx];
    if (!item.reserva) return String(idx + 1);
    const nMain = examen.filter(it => !it.reserva).length;
    return 'R' + (idx - nMain + 1);
  }

  function renderPregunta(item, idx, revision) {
    const q = item.ref;
    const card = document.createElement('div');
    card.className = 'q-card' + (item.reserva ? ' reserva' : '');
    card.id = `q-${idx}`;
    card.dataset.idx = idx;

    const head = document.createElement('div');
    head.className = 'q-head';
    let headHtml = `<span class="q-num${item.reserva ? ' rsv' : ''}">${numeroVisible(idx)}</span>`;
    if (item.reserva) headHtml += `<span class="rsv-tag">RESERVA</span>`;
    if (revision && !respuestas[q.id]) headHtml += `<span class="blank-tag">SIN RESPONDER</span>`;
    if (revision) {
      const src = origenTag(q);
      if (src) headHtml += `<span class="src-tag${/oficial/.test(src) ? ' oficial' : ''}">${src}</span>`;
    }
    headHtml += `<span class="q-tema-tag">${revision ? temaTitulo(q.tema) : 'Tema ' + q.tema}</span>`;
    head.innerHTML = headHtml;
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
        opt.tabIndex = 0;
        opt.setAttribute('role', 'button');
        opt.addEventListener('click', () => seleccionar(q.id, claveOrig, idx));
        opt.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seleccionar(q.id, claveOrig, idx); }
        });
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
    actualizarPaletteEstado();
    actualizarProgreso();
    guardarEnCurso();
  }

  function renderPalette() {
    const pal = $('#palette');
    pal.innerHTML = '';
    examen.forEach((item, i) => {
      const b = document.createElement('button');
      b.textContent = numeroVisible(i);
      b.dataset.idx = i;
      if (item.reserva) b.classList.add('rsv');
      if (respuestas[item.ref.id]) b.classList.add('answered');
      if (i === idxActual) b.classList.add('current');
      b.addEventListener('click', () => {
        $(`#q-${i}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      pal.appendChild(b);
    });
  }

  function actualizarPaletteEstado() {
    $$('#palette button').forEach(b => {
      const i = Number(b.dataset.idx);
      b.classList.toggle('answered', !!respuestas[examen[i].ref.id]);
      b.classList.toggle('current', i === idxActual);
    });
  }

  // Seguimiento de la pregunta visible (para paleta y teclado)
  function observarPreguntaActual() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) {
        idxActual = Number(visible[0].target.dataset.idx);
        actualizarPaletteEstado();
      }
    }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });
    $$('#questions-container .q-card').forEach(c => observer.observe(c));
  }

  // Teclado: 1-4 / a-d responden la pregunta visible; n/p navegan
  function onKeydown(e) {
    if ($('#view-exam').classList.contains('hidden')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    const k = e.key.toLowerCase();
    let pos = -1;
    if (k >= '1' && k <= '4') pos = Number(k) - 1;
    else if (['a', 'b', 'c', 'd'].includes(k)) pos = LETRAS.indexOf(k);

    if (pos >= 0) {
      const item = examen[idxActual];
      if (item && item.orden[pos] != null) {
        e.preventDefault();
        seleccionar(item.ref.id, item.orden[pos], idxActual);
      }
      return;
    }
    if (k === 'n' || k === 'p') {
      e.preventDefault();
      const next = Math.min(Math.max(idxActual + (k === 'n' ? 1 : -1), 0), examen.length - 1);
      $(`#q-${next}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
      if (segundosRestantes % 15 === 0) guardarEnCurso();
      if (segundosRestantes <= 0) {
        stopTimer();
        alert('Se acabó el tiempo. Se corregirá el examen.');
        corregirExamen(true);
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
  function corregirExamen(tiempoAgotado) {
    const sinResponder = examen.length - examen.filter(it => respuestas[it.ref.id]).length;
    if (sinResponder > 0 && !tiempoAgotado) {
      if (!confirm(`Tienes ${sinResponder} preguntas sin responder. ¿Corregir de todas formas?`)) return;
    }
    stopTimer();
    limpiarEnCurso();

    let ok = 0, bad = 0, blank = 0;
    let rOk = 0, rTotal = 0;
    const porTema = {};
    const falladasExamen = [];
    const acertadasExamen = [];

    examen.forEach(it => {
      const q = it.ref;
      const r = respuestas[q.id];
      if (it.reserva) {
        rTotal++;
        if (r === q.respuesta) rOk++;
        else if (r) falladasExamen.push(q.id);
        return; // la reserva no puntúa ni computa por tema
      }
      porTema[q.tema] = porTema[q.tema] || { ok: 0, total: 0 };
      porTema[q.tema].total++;
      if (!r) blank++;
      else if (r === q.respuesta) { ok++; porTema[q.tema].ok++; acertadasExamen.push(q.id); }
      else { bad++; falladasExamen.push(q.id); }
    });

    const nPrincipales = examen.filter(it => !it.reserva).length;
    const notaMax = nPrincipales * EX.aciertoSuma;
    const nota = Math.max(0, ok * EX.aciertoSuma - bad * EX.falloResta);
    const nota10 = notaMax > 0 ? nota / notaMax * 10 : 0;
    const pct = Math.round(ok / nPrincipales * 100);

    $('#r-ok').textContent = ok;
    $('#r-bad').textContent = bad;
    $('#r-blank').textContent = blank;
    $('#r-nota').textContent = `${nota.toFixed(2)} / ${notaMax} (equivale a ${nota10.toFixed(2)}/10)`;

    const liReserva = $('#r-reserva-li');
    if (rTotal > 0) {
      liReserva.classList.remove('hidden');
      $('#r-reserva').textContent = `${rOk}/${rTotal}`;
    } else {
      liReserva.classList.add('hidden');
    }

    const circle = $('#score-circle');
    $('#score-pct').textContent = nota10.toFixed(1);
    $('#score-sub').textContent = 'nota /10';
    circle.className = 'score-circle ' + (nota10 >= 5 ? 'good' : nota10 >= 4 ? 'mid' : 'bad');
    $('#score-grade').textContent = nota10 >= 5 ? 'Aprobado' : nota10 >= 4 ? 'Casi' : 'A repasar';

    // Botón de repetir falladas de este examen
    $('#retry-failed-btn').classList.toggle('hidden', falladasExamen.length === 0);
    $('#retry-failed-btn').dataset.ids = JSON.stringify(falladasExamen);

    // Actualizar banco de falladas persistente: se añaden las falladas,
    // se retiran las que esta vez se han acertado.
    const set = falladasSet();
    falladasExamen.forEach(id => set.add(id));
    acertadasExamen.forEach(id => set.delete(id));
    LS.set('opos.falladas', Array.from(set).slice(-800));

    // Guardar en historial
    const hist = LS.get('opos.historial', []);
    hist.unshift({ f: Date.now(), modo, n: nPrincipales, ok, bad, blank, nota, notaMax, nota10, porTema });
    LS.set('opos.historial', hist.slice(0, 50));

    renderTemaStats(porTema);
    $('#review-container').innerHTML = '';
    cambiarVista('results');
    window.scrollTo(0, 0);
  }

  function repetirFalladasExamen() {
    let ids = [];
    try { ids = JSON.parse($('#retry-failed-btn').dataset.ids || '[]'); } catch { }
    const pool = ids.map(id => POR_ID.get(id)).filter(Boolean);
    if (!pool.length) return;
    modo = 'falladas';
    examen = shuffle(pool).map(q => ({ ref: q, orden: shuffle(Object.keys(q.opciones)), reserva: false }));
    respuestas = {};
    idxActual = 0;
    renderExamen();
    cambiarVista('exam');
    stopTimer();
    segundosRestantes = 0;
    $('#timer').classList.add('hidden');
    guardarEnCurso();
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
    if (observer) { observer.disconnect(); observer = null; }
    examen = []; respuestas = {}; segundosRestantes = 0; idxActual = 0;
    $('#review-container').innerHTML = '';
    cerrarConfig();
    refrescarHome();
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

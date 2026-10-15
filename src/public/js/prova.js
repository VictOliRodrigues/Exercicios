// Prova: cronômetro, tempo limite, salvamento automático e mapa de questões. Sem JS, a prova
// continua funcionando: Anterior, Próxima, o mapa e Finalizar enviam o formulário e salvam a página.

const pad = (value) => String(value).padStart(2, '0');

function formatClock(totalSeconds) {
  const value = Math.max(0, totalSeconds);
  return `${pad(Math.floor(value / 3600))}:${pad(Math.floor((value % 3600) / 60))}:${pad(value % 60)}`;
}

// Cronômetro. Parte dos segundos que o servidor informou ao abrir a página: recarregar não zera
// o tempo. Quando o tempo limite chega a zero, envia Finalizar sem confirmação.
const clock = document.querySelector('[data-exam-clock]');
if (clock) {
  const openedAt = performance.now();
  const elapsedAtOpen = Number(clock.dataset.elapsed);
  const remainingAtOpen =
    clock.dataset.remaining === undefined ? null : Number(clock.dataset.remaining);
  const elapsedOutput = clock.querySelector('[data-clock-elapsed]');
  const remainingOutput = clock.querySelector('[data-clock-remaining]');
  const remainingBox = clock.querySelector('[data-clock-remaining-box]');
  let finishing = false;

  const finishByTime = () => {
    if (finishing) return;
    finishing = true;
    const form = document.getElementById(clock.dataset.finishForm);
    if (!form) return window.location.reload();
    form.action = clock.dataset.finishUrl;
    form.submit();
  };

  const tick = () => {
    const passed = Math.floor((performance.now() - openedAt) / 1000);
    elapsedOutput.textContent = formatClock(elapsedAtOpen + passed);
    if (remainingAtOpen === null) return;
    const remaining = Math.max(0, remainingAtOpen - passed);
    remainingOutput.textContent = formatClock(remaining);
    remainingBox.classList.toggle('is-urgent', remaining <= 300);
    if (remaining === 0) finishByTime();
  };

  tick();
  setInterval(tick, 500);
}

const form = document.getElementById('form-prova');
if (form) {
  const answerUrl = form.dataset.answerUrl;
  const currentPage = form.dataset.page;
  const token = form.querySelector('input[name="_csrf"]').value;
  const status = form.querySelector('[data-save-status]');
  const counter = document.querySelector('[data-answered-count]');
  const map = document.querySelector('[data-exam-map]');

  const setStatus = (message) => {
    status.textContent = message;
  };

  // As respostas vão uma de cada vez, na ordem dos cliques: a última marcada é a que fica salva.
  let queue = Promise.resolve();

  const save = async (number, letter) => {
    try {
      const response = await fetch(answerUrl + number, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ alternativa: letter }),
        credentials: 'same-origin',
      });
      const data = await response.json().catch(() => null);
      if (response.status === 409 && data?.relatorio) {
        window.location.assign(data.relatorio);
        return;
      }
      if (!response.ok || !data) throw new Error(`HTTP ${response.status}`);
      if (counter) counter.textContent = data.respondidas;
      setStatus('');
    } catch {
      setStatus(
        'Não foi possível salvar a resposta agora. Ela será salva quando você mudar de página ou finalizar.',
      );
    }
  };

  form.addEventListener('change', (event) => {
    const input = event.target;
    if (!input.matches('input[type="radio"][name^="q"]')) return;
    const number = input.name.slice(1);
    const mapItem = form.querySelector(`[data-map-number="${number}"]`);
    if (mapItem) {
      mapItem.classList.add('is-answered');
      mapItem.setAttribute('aria-label', `Questão ${number}, respondida`);
    }
    queue = queue.then(() => save(number, Number(input.value)));
  });

  // Questão da página atual: só rola a tela, sem recarregar.
  form.addEventListener('click', (event) => {
    const item = event.target.closest('[data-map-number]');
    if (!item || item.dataset.mapPage !== currentPage) return;
    const question = document.getElementById(`questao-${item.dataset.mapNumber}`);
    if (!question) return;
    event.preventDefault();
    question.scrollIntoView({ behavior: 'smooth', block: 'start' });
    question.querySelector('input')?.focus({ preventScroll: true });
    if (map && window.matchMedia('(max-width: 760px)').matches) map.open = false;
  });

  // No celular, o mapa começa recolhido.
  if (map && window.matchMedia('(max-width: 760px)').matches) map.open = false;
}

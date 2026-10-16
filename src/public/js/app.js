// Comportamentos comuns das telas. Sem JS, tudo continua funcionando (só sem cópia rápida e sem
// a pergunta de confirmação).

// Botão "Copiar": <button data-copy="id-do-elemento">. Copia o valor de um campo ou o texto.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  const text = 'value' in source ? source.value : source.textContent;
  // Com ícone no botão, só o texto do [data-copy-label] muda.
  const target = button.querySelector('[data-copy-label]') || button;
  const label = button.dataset.label || target.textContent;
  button.dataset.label = label;

  try {
    await navigator.clipboard.writeText(text);
    target.textContent = 'Copiado!';
  } catch {
    // Sem acesso à área de transferência (página sem HTTPS, por exemplo): seleciona o texto.
    if ('select' in source) {
      source.select();
    } else {
      window.getSelection().selectAllChildren(source);
    }
    target.textContent = 'Selecionado: use Ctrl+C';
  }
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    target.textContent = label;
  }, 2500);
});

// Número ao lado de uma opção (<input data-checks="id-do-radio">): mexer nele marca a opção.
document.addEventListener('focusin', (event) => {
  const input = event.target.closest('[data-checks]');
  const radio = input && document.getElementById(input.dataset.checks);
  if (radio) radio.checked = true;
});

// Janela aberta pelo servidor (<dialog class="modal" open>): vira modal de verdade, com o resto da
// página inerte. Esc leva para o endereço de fechar.
for (const dialog of document.querySelectorAll('dialog.modal[open]')) {
  dialog.close();
  dialog.showModal();
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    window.location.href = dialog.dataset.closeHref;
  });
}

// Formulário com data-confirm="Pergunta?": só envia depois de confirmar.
document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) event.preventDefault();
});

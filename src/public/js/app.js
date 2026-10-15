// Comportamentos comuns das telas. Sem JS, tudo continua funcionando (só sem cópia rápida e sem
// a pergunta de confirmação).

// Botão "Copiar": <button data-copy="id-do-elemento">. Copia o valor de um campo ou o texto.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  const text = 'value' in source ? source.value : source.textContent;
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;

  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copiado!';
  } catch {
    // Sem acesso à área de transferência (página sem HTTPS, por exemplo): seleciona o texto.
    if ('select' in source) {
      source.select();
    } else {
      window.getSelection().selectAllChildren(source);
    }
    button.textContent = 'Selecionado: use Ctrl+C';
  }
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    button.textContent = label;
  }, 2500);
});

// Formulário com data-confirm="Pergunta?": só envia depois de confirmar.
document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) event.preventDefault();
});

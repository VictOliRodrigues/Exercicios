// Comportamentos comuns das telas. Sem JS, tudo continua funcionando (só sem cópia rápida, sem
// a pergunta de confirmação e sem o botão de modo claro/escuro).

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

// Formulário com data-confirm="Texto": só envia depois de confirmar na janela #confirmar-acao.
// data-confirm-title e data-confirm-button dão o título e o texto do botão de confirmar.
{
  const dialog = document.getElementById('confirmar-acao');
  let pending = null;
  let confirmed = null;

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-confirm]');
    if (!form) return;
    if (form === confirmed) {
      confirmed = null;
      return;
    }
    event.preventDefault();
    if (!dialog?.showModal) {
      if (window.confirm(form.dataset.confirm)) form.submit();
      return;
    }
    pending = { form, submitter: event.submitter };
    dialog.querySelector('#confirmar-titulo').textContent =
      form.dataset.confirmTitle || 'Tem certeza?';
    dialog.querySelector('#confirmar-texto').textContent = form.dataset.confirm;
    dialog.querySelector('[data-confirm-ok]').textContent =
      form.dataset.confirmButton || 'Confirmar';
    dialog.showModal();
  });

  if (dialog) {
    dialog.querySelector('[data-confirm-ok]').addEventListener('click', () => {
      const { form, submitter } = pending;
      dialog.close();
      confirmed = form;
      if (submitter) form.requestSubmit(submitter);
      else form.requestSubmit();
    });
    dialog.querySelector('[data-confirm-cancel]').addEventListener('click', () => dialog.close());
    // Clicar no fundo escuro, fora da janela, também cancela.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

// Modo claro/escuro. Sem escolha, vale o tema do sistema. O botão grava a escolha num cookie, que o
// servidor lê para já mandar a página no tema certo.
// Fica num bloco porque os scripts das páginas (prova.js) dividem o mesmo escopo global.
{
  const root = document.documentElement;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const themeButtons = document.querySelectorAll('[data-theme-toggle]');
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : systemDark.matches);

  const syncThemeButtons = () => {
    const label = isDark() ? 'Mudar para o modo claro' : 'Mudar para o modo escuro';
    for (const button of themeButtons) {
      button.setAttribute('aria-label', label);
      button.title = label;
      button.hidden = false;
    }
  };

  for (const button of themeButtons) {
    button.addEventListener('click', () => {
      const theme = isDark() ? 'light' : 'dark';
      root.dataset.theme = theme;
      const secure = window.location.protocol === 'https:' ? '; secure' : '';
      document.cookie = `tema=${theme}; path=/; max-age=31536000; samesite=lax${secure}`;
      syncThemeButtons();
    });
  }
  systemDark.addEventListener('change', syncThemeButtons);
  syncThemeButtons();
}

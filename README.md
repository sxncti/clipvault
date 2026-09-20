# ClipVault

Histórico da área de transferência para GNOME Shell, inspirado no `Win + V`
do Windows. Pressione `Super + V`, pesquise um texto e pressione `Enter` para
colá-lo no aplicativo que estava ativo.

## Recursos

- atalho global `Super + V`;
- histórico persistente dos 50 textos mais recentes;
- pesquisa instantânea;
- navegação por teclado (`↓`, `↑`, `Enter` e `Esc`);
- itens fixados, exclusão individual e limpeza dos itens não fixados;
- modo privado para pausar a captura;
- ignora o marcador de conteúdo secreto usado por gerenciadores de senha;
- colagem automática no aplicativo anterior;
- compatibilidade com GNOME Shell 45 a 50, em Wayland e X11;
- sem serviços externos e sem telemetria.

> [!IMPORTANT]
> Assim como qualquer gerenciador de clipboard, o ClipVault pode armazenar
> senhas, tokens e outros textos sensíveis que você copiar. O arquivo fica local,
> com permissão `0600`, em `~/.local/share/clipvault/history.json`.

## Instalação

Requisitos: GNOME Shell e `glib-compile-schemas` (normalmente já instalado).

```bash
git clone https://github.com/sxncti/clipvault.git
cd clipvault
./install.sh
```

Depois, encerre e inicie a sessão novamente. Ative a extensão:

```bash
gnome-extensions enable clipvault@sxncti.github.com
```

O GNOME também usa `Super + V` para a bandeja de mensagens. Quando houver esse
conflito, o instalador pergunta se pode remover apenas `Super + V` da bandeja
(o atalho alternativo `Super + M` é preservado) e salva um backup da configuração.
Para fazer isso manualmente:

```bash
gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Super>m']"
```

No X11, `Alt + F2`, seguido de `r`, também reinicia o GNOME Shell sem logout.

## Uso

1. Copie textos normalmente com `Ctrl + C`.
2. Pressione `Super + V` para abrir o histórico.
3. Digite para pesquisar, pressione `↓` para entrar na lista e `Enter` para
   escolher. O texto será colado automaticamente.

O ícone de prancheta na barra superior abre o mesmo menu com o mouse. A estrela
fixa um item; a lixeira o exclui. Ative **Modo privado** no rodapé para pausar a
captura de novos textos.

## Configuração

Alterar o limite (entre 10 e 200):

```bash
gsettings set org.gnome.shell.extensions.clipvault history-size 100
```

Desativar a colagem automática (o item continuará sendo copiado):

```bash
gsettings set org.gnome.shell.extensions.clipvault auto-paste false
```

Alterar o atalho, por exemplo para `Super + Shift + V`:

```bash
gsettings set org.gnome.shell.extensions.clipvault toggle-menu "['<Super><Shift>v']"
```

## Limitações

- A versão atual guarda texto, não imagens ou arquivos.
- Aplicativos que bloqueiam eventos de teclado sintéticos podem exigir um
  `Ctrl + V` manual; o item selecionado já estará no clipboard.
- O menu mostra até 12 resultados de cada vez; a pesquisa considera todo o
  histórico.

## Desenvolvimento

```bash
make check
make package
```

Para acompanhar erros da extensão:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## Desinstalação

```bash
./uninstall.sh
```

O desinstalador preserva tanto a extensão quanto o histórico em locais
recuperáveis e informa esses caminhos ao terminar.

## Licença

[MIT](LICENSE)

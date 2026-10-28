/**
 * Browser half of `dsh-copy-file-link`.
 *
 * The right Sidebar's document preview declares `sidebar.right.tab.document.actions`
 * once the previewed file's Host path is known, and dispatches it with
 * `{ absolutePath }`. This package registers one list entry there: an icon-only
 * control that writes that absolute local path into the clipboard, verbatim.
 *
 * Only `react` is taken from the browser module table; styles are this
 * package's own stylesheet and use theme tokens, so no Harness Client package
 * is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-copy-file-link',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace this package owns. */
    const NS = 'copyFileLink';
    /** This package's visible text, in every shipped locale. */
    const DICTS = {
      zh: {
        hint: '复制该文件的绝对路径',
        copied: '已复制',
        failed: '复制失败',
      },
      en: {
        hint: 'Copy this file\'s absolute path',
        copied: 'Copied',
        failed: 'Copy failed',
      },
    };
    /** Geometry matched to the icon-only controls already in the preview header. */
    const CSS = [
      '.dcfl_button{box-sizing:border-box;width:28px;height:28px;flex:none;display:inline-flex;',
      'align-items:center;justify-content:center;padding:6px;color:var(--dsw-alias-label-secondary);',
      'background:0 0;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;line-height:1}',
      '.dcfl_button svg{width:15px;height:15px}',
      '.dcfl_button:hover:not(:disabled){color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcfl_button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-active)}',
      '.dcfl_button[data-status=copied]{color:var(--dsw-alias-state-success-primary)}',
      '.dcfl_button[data-status=failed]{color:var(--dsw-alias-state-error-primary)}',
    ].join('');

    // #region path-helpers
    /**
     * The clipboard text: the file's absolute local path, exactly as the Host
     * spells it — no Markdown wrapper, no angle brackets, no separator rewrite.
     * @param absolutePath - the previewed file's absolute path.
     * @returns the path text.
     */
    function clipboardText(absolutePath) {
      return String(absolutePath);
    }
    // #endregion path-helpers

    /**
     * Write text to the host clipboard, preferring the async Clipboard API and
     * falling back to `execCommand('copy')` where it is missing (an insecure
     * context) or refused.
     * @param text - the exact text to place on the clipboard.
     * @returns true only when the host accepted the write.
     */
    async function writeClipboard(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          /* fall through to the legacy path */
        }
      }
      const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined;
      if (exec === undefined) return false;
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      try {
        return exec('copy');
      } catch {
        return false;
      } finally {
        el.remove();
      }
    }

    /** The idle glyph: a chain link. */
    function LinkIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M10.6 13.4a4.2 4.2 0 0 0 6.3.5l2.5-2.5a4.2 4.2 0 0 0-5.9-5.9l-1.5 1.4' }),
        h('path', { d: 'M13.4 10.6a4.2 4.2 0 0 0-6.3-.5l-2.5 2.5a4.2 4.2 0 0 0 5.9 5.9l1.5-1.4' }),
      );
    }

    /** The confirmed glyph: a check mark. */
    function CheckIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M20 6 9 17l-5-5' }));
    }

    /** The failure glyph: an exclamation circle. */
    function AlertIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M12 8v5' }),
        h('path', { d: 'M12 16.4h.01' }),
      );
    }

    /**
     * The document header's copy control.
     * @param props - the seat's `absolutePath` owner prop and the entry's `t` seat.
     * @returns the control, or null without a usable path.
     */
    function CopyFileLinkButton(props) {
      const { absolutePath, t } = props;
      const text = React.useMemo(() => clipboardText(absolutePath), [absolutePath]);
      const [status, setStatus] = React.useState('idle');
      const timer = React.useRef(null);
      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      }, []);
      if (typeof absolutePath !== 'string' || absolutePath === '') return null;
      const copy = () => {
        writeClipboard(text).then((accepted) => {
          setStatus(accepted ? 'copied' : 'failed');
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            setStatus('idle');
          }, 1400);
        });
      };
      const description = status === 'copied' ? t('copied') : status === 'failed' ? t('failed') : t('hint');
      return h('button', {
        type: 'button',
        className: 'dcfl_button',
        'data-copy-file-link': '',
        'data-status': status,
        title: status === 'idle' ? description + ': ' + text : description,
        'aria-label': status === 'idle' ? description + ': ' + text : description,
        onClick: copy,
      }, status === 'copied' ? h(CheckIcon) : status === 'failed' ? h(AlertIcon) : h(LinkIcon));
    }

    return {
      /** Required client services: the slot registry and the dictionary registry. */
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries, the package stylesheet, and the header entry.
       * @param ctx - client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'copy-file-link: dictionaries');
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-copy-file-link';
          tag.dataset.pluginCss = 'dsh-copy-file-link/client.css';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'copy-file-link: styles');
        /* The seat is declared by the document preview; `inject` waits for that
         * declaration when this plugin happens to activate first. */
        ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'copy-file-link',
          order: 5,
          locale: NS,
        }, CopyFileLinkButton));
      },
    };
  },
});

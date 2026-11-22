'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, use, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backendUnavailable, dashboardRequest, unconfirmedAction } from './api.js';
import { confirmationFor } from './game.js';
import { routes } from './routes.js';
import { Icon } from './ui.jsx';

const DashboardContext = createContext(null);
const DraftContext = createContext(null);
const syncInterval = 5000;

export function useDashboard() {
  return use(DashboardContext);
}

export function useDraft(key, fallback) {
  const [drafts, setDrafts] = use(DraftContext);
  return [drafts[key] ?? fallback, (value) => setDrafts((current) => ({ ...current, [key]: value }))];
}

function Confirmation({ detail, onResult }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!detail) return;
    const dialog = ref.current;
    dialog.returnValue = '';
    dialog.showModal();
  }, [detail]);
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" aria-describedby="confirm-detail" onClose={(event) => {
      const dialog = event.currentTarget;
      const confirmed = dialog.returnValue === 'confirm';
      dialog.returnValue = '';
      onResult(confirmed);
    }}>
      <h2 id="confirm-title">{detail?.title ?? '確認操作'}</h2>
      <p id="confirm-detail">{detail?.detail}</p>
      <form method="dialog" className="dialog-actions">
        <button type="submit" className="button tonal" value="cancel" autoFocus>取消</button>
        <button type="submit" className="button filled" value="confirm">{detail?.submit ?? '確認送出'}</button>
      </form>
    </dialog>
  );
}

function DataAge({ receivedAt, offline }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!receivedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [receivedAt]);
  if (!receivedAt) return null;
  return <span className="data-age">{offline ? '舊資料 · ' : ''}{Math.max(0, Math.floor((now - receivedAt) / 1000))} 秒前更新</span>;
}

function Navigation({ path }) {
  return (
    <aside className="sidebar">
      <Link className="brand" href="/" prefetch={false}>
        <span className="brand-mark"><Icon name="brand" /></span>
        <span>大地遊戲</span>
      </Link>
      <nav aria-label="管理視圖">
        {routes.map(({ path: href, title, icon }) => (
          <Link key={href} href={href} prefetch={false} aria-current={path === href ? 'page' : undefined}>
            <Icon name={icon} /><span>{title}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function Dashboard({ children }) {
  const path = usePathname();
  const title = routes.find((route) => route.path === path)?.title ?? routes[0].title;
  const heading = useRef(null);
  const previousPath = useRef(path);
  const [snapshot, setSnapshot] = useState({ state: null, receivedAt: 0, connection: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const drafts = useState({});
  const controls = useRef({ online: false, read: null, sending: null, pending: null, actionFailed: false });
  const { state, connection, receivedAt } = snapshot;
  const offline = connection === 'offline';

  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      heading.current?.focus({ preventScroll: true });
    }
  }, [path]);

  function setOnline(next) {
    controls.current.online = true;
    setSnapshot({ state: next, receivedAt: Date.now(), connection: 'online' });
  }

  function setOffline() {
    controls.current.online = false;
    setSnapshot((current) => ({ ...current, connection: 'offline' }));
  }

  async function refresh(manual = false) {
    const activity = controls.current;
    if (activity.read || activity.sending || activity.pending) return;
    const controller = new AbortController();
    activity.read = controller;
    setRefreshing(true);
    try {
      const next = await dashboardRequest({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
      if (controller.signal.aborted) return;
      setOnline(next);
      if (manual || !activity.actionFailed) setError('');
      if (manual) {
        activity.actionFailed = false;
        setNotice('已更新');
      }
    } catch {
      if (controller.signal.aborted) return;
      setOffline();
      setError(backendUnavailable);
    } finally {
      if (activity.read === controller) {
        activity.read = null;
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    const activity = controls.current;
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = setInterval(refreshVisible, syncInterval);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      activity.read?.abort();
      activity.read = null;
      activity.sending?.abort();
    };
  }, []);

  async function send(payload, title) {
    const activity = controls.current;
    if (!activity.online || activity.sending) return;
    activity.read?.abort();
    activity.read = null;
    const controller = new AbortController();
    activity.sending = controller;
    activity.actionFailed = false;
    setRefreshing(false);
    setBusy(payload.action);
    setError('');
    setNotice('');
    try {
      const next = await dashboardRequest({ payload, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
      if (controller.signal.aborted) return;
      setOnline(next);
      setNotice(`${title}：已套用。`);
    } catch (failure) {
      if (controller.signal.aborted) return;
      activity.actionFailed = true;
      if (failure.message === backendUnavailable || failure.message === unconfirmedAction) setOffline();
      setError(failure.message);
    } finally {
      activity.sending = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  function submit(payload, formTitle) {
    const activity = controls.current;
    if (!activity.online || activity.sending || activity.pending) return;
    const detail = confirmationFor(payload, state);
    if (!detail) {
      void send(payload, formTitle);
      return;
    }
    activity.pending = { payload, formTitle };
    setConfirmation(detail);
  }

  function finishConfirmation(confirmed) {
    const activity = controls.current;
    const pending = activity.pending;
    activity.pending = null;
    setConfirmation(null);
    if (confirmed && pending) void send(pending.payload, pending.formTitle);
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#page-title">跳至主要內容</a>
      <Navigation path={path} />
      <main>
        <header className="topbar">
          <h1 ref={heading} id="page-title" tabIndex={-1}>{title}</h1>
          <div className="sync">
            <div className="sync-details">
              <span className={`chip connection ${connection}`}>{offline ? '離線' : connection === 'online' ? '已連線' : '連線中'}</span>
              <DataAge receivedAt={receivedAt} offline={offline} />
            </div>
            <button type="button" className="button outlined" disabled={refreshing || busy !== null || connection === 'loading'} onClick={() => void refresh(true)}>
              <Icon name="refresh" />重新整理
            </button>
          </div>
        </header>
        <noscript><p className="message error">請啟用 JavaScript。</p></noscript>
        <div role="alert">{error ? <p className="message error"><Icon name="alert" />{error}</p> : null}</div>
        <div role="status">{notice ? <p className="message success"><Icon name="complete" />{notice}</p> : null}</div>
        {connection === 'loading' ? <div role="status" className="loading"><progress aria-label="載入中" />載入中…</div> : null}
        <DashboardContext value={{ state, writable: state !== null && !offline && busy === null, busy, submit, announce: setNotice }}>
          <DraftContext value={drafts}>{children}</DraftContext>
        </DashboardContext>
      </main>
      <Confirmation detail={confirmation} onResult={finishConfirmation} />
    </div>
  );
}

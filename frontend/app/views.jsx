'use client';

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { actionsPath } from './api.js';
import { useDashboard, useDraft } from './dashboard.jsx';
import { actionPayload, boothNames, count, inventoryNames, inventoryQuantity, nameOf, number, parameters, phaseNames, planetNames, roleNames, time } from './game.js';
import { Card, ChoiceGroup, DataTable, Field, Icon, NumberField } from './ui.jsx';

const none = [];
const identifierProps = { spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off', autoComplete: 'off' };
const defaultStation = { stationId: '', name: '', packs: '1', limit: '1', remaining: '100', open: true };
const unloaded = '尚未取得資料。';
const boothChoices = Object.entries(boothNames).map(([value, label]) => <option key={value} value={value}>{label}</option>);

function ActionForm({ id, title, action, submitLabel, tools, submitDisabled = false, children }) {
  const heading = useId();
  const { writable, busy, submit } = useDashboard();
  return (
    <form id={id} className="card action-form" action={actionsPath} method="post" aria-labelledby={heading}
      aria-busy={busy === action ? true : undefined} onSubmit={(event) => {
        event.preventDefault();
        if (writable) submit(actionPayload(action, event.currentTarget), title);
      }}>
      <div className="section-heading"><h2 id={heading}>{title}</h2>{tools}</div>
      <fieldset className="form-controls" disabled={!writable}>
        <legend className="sr-only">{title}欄位</legend>
        {children}
        <div className="form-actions"><button type="submit" className="button filled" disabled={submitDisabled}>{submitLabel}</button></div>
      </fieldset>
    </form>
  );
}

function Metric({ title, value, icon, children }) {
  return (
    <div className="metric">
      <dt><Icon name={icon} />{title}</dt>
      <dd>{value}{children}</dd>
    </div>
  );
}

export function Overview() {
  const { state } = useDashboard();
  const players = state?.players ?? none;
  const checkedIn = players.reduce((total, player) => total + Number(Boolean(player.checkedIn)), 0);
  const sum = (key) => players.reduce((total, player) => total + count(player[key]), 0);
  const display = (value) => state ? number(value) : '—';
  const snapshot = [
    ['手牌總數', sum('handTotal')], ['金幣總數', sum('coins')],
    ['打卡掃描次數', state?.checkpoints?.reduce((total, entry) => total + count(entry.scans), 0)], ['管理操作紀錄', state?.audit],
  ];
  return (
    <div className="view overview">
      <Card title="現場數據">
        <dl className="metrics">
          <Metric title="已報到玩家" value={display(checkedIn)} icon="players">{state ? <small> / {number(players.length)}</small> : null}</Metric>
          <Metric title="未開卡包" value={display(sum('packs'))} icon="packs" />
          <Metric title="開放發卡站" value={display(state?.stations.filter((station) => station.open).length)} icon="stations" />
        </dl>
        <dl className="stats">{snapshot.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>
      </Card>
      <div className="overview-side">
        <Card title="活動階段" action={<Icon name="event" />}>
          <p className="phase-value">{nameOf(phaseNames, state?.phase)}</p>
          <Link className="button filled" href="/event" prefetch={false}>管理活動 <Icon name="arrow" /></Link>
        </Card>
        <Card title="常用操作">
          <div className="quick-links">
            <Link href="/players" prefetch={false}><Icon name="players" />管理玩家<Icon name="arrow" /></Link>
            <Link href="/stations" prefetch={false}><Icon name="stations" />管理發卡站<Icon name="arrow" /></Link>
            <Link href="/audit" prefetch={false}><Icon name="audit" />查看操作紀錄<Icon name="arrow" /></Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ParameterForm() {
  const { state, writable, announce } = useDashboard();
  const [draft, setDraft] = useDraft('parameters', state?.parameters ?? {});
  return (
    <ActionForm id="parameters-form" title="遊戲參數" action="parameters" submitLabel="儲存遊戲參數"
      tools={<button className="button tonal" type="button" disabled={!writable} onClick={() => {
        setDraft(state.parameters ?? {});
        announce('已載入目前參數，尚未儲存。');
      }}>載入目前參數</button>}>
      <p className="hint">金幣獎勵可為 0；其他參數需大於 0。一般上限 3,600；議程卡包 1–3。</p>
      <div className="form-grid">
        {parameters.map(([name, label, min, max]) => <NumberField key={name} id={`parameter-${name}`} name={name} label={`${label}（必填）`} min={min} max={max}
          value={draft[name] ?? ''} onChange={(event) => setDraft({ ...draft, [name]: event.target.value })} />)}
      </div>
    </ActionForm>
  );
}

export function Event() {
  const { state } = useDashboard();
  const [phase, setPhase] = useDraft('phase', Object.hasOwn(phaseNames, state?.phase) ? state.phase : 'before');
  const [slot, setSlot] = useDraft('slot', '');
  return (
    <div className="view">
      <div className="two-columns">
        <ActionForm id="phase-form" title="活動階段" action="phase" submitLabel="套用活動階段"
          tools={<span className="chip secondary">目前：{nameOf(phaseNames, state?.phase)}</span>}>
          <ChoiceGroup name="phase" label="切換至" choices={phaseNames} value={phase} onChange={setPhase} />
          <p className="hint">結束活動前會再次確認。</p>
        </ActionForm>
        <ActionForm id="agenda-form" title="議程發包" action="agenda" submitLabel="確認議程發包">
          <Field id="agenda-slot" label="議程時段識別碼（必填）" help="例如 day1-session1。同一時段只向已報到玩家發送一次。">
            <input id="agenda-slot" name="slot" required maxLength={120} aria-describedby="agenda-slot-help" value={slot} onChange={(event) => setSlot(event.target.value)} {...identifierProps} />
          </Field>
        </ActionForm>
      </div>
      <ParameterForm />
    </div>
  );
}

function RewardsForm({ playerId }) {
  const [draft, setDraft] = useState({ deliveryId: '', amount: '1', reason: '' });
  const patch = (key, value) => setDraft({ ...draft, [key]: value });
  return (
    <ActionForm id="rewards-form" title={playerId === 'all' ? '全體卡包獎勵' : '遠端卡包獎勵'} action="remotePacks" submitLabel="發送遠端卡包">
      <input type="hidden" name="playerId" value={playerId} />
      <Field id="delivery-id" label="投遞識別碼（必填）" help="相同識別碼只投遞一次。">
        <input id="delivery-id" name="deliveryId" required maxLength={120} aria-describedby="delivery-id-help" value={draft.deliveryId} onChange={(event) => patch('deliveryId', event.target.value)} {...identifierProps} />
      </Field>
      <NumberField id="reward-amount" name="amount" label="每人卡包數（必填，1–10,000）" min={1} max={10000} value={draft.amount} onChange={(event) => patch('amount', event.target.value)} />
      <Field id="reward-reason" label="發送原因（必填）">
        <input id="reward-reason" name="reason" required maxLength={1000} value={draft.reason} onChange={(event) => patch('reason', event.target.value)} />
      </Field>
    </ActionForm>
  );
}

function PhotoForm({ playerId }) {
  return (
    <ActionForm id="photo-form" title="合照任務" action="photo" submitLabel="確認合照完成">
      <input type="hidden" name="playerId" value={playerId} />
    </ActionForm>
  );
}

function BoothForm({ playerId }) {
  const [boothId, setBoothId] = useState('booth-1');
  return (
    <ActionForm id="booth-form" title="攤位任務" action="boothComplete" submitLabel="確認攤位任務完成">
      <input type="hidden" name="playerId" value={playerId} />
      <Field id="booth-id" label="攤位">
        <select id="booth-id" name="boothId" value={boothId} onChange={(event) => setBoothId(event.target.value)}>{boothChoices}</select>
      </Field>
    </ActionForm>
  );
}

function RoleForm({ player }) {
  const [draft, setDraft] = useState(null);
  const role = draft ?? { role: Object.hasOwn(roleNames, player.role) ? player.role : 'user', boothId: player.boothId ?? '' };
  const needsBooth = role.role === 'booth';
  return (
    <ActionForm id="role-form" title="測試玩家角色" action="role" submitLabel="套用玩家角色">
      <input type="hidden" name="playerId" value={player.id} />
      <ChoiceGroup name="role" label="角色（必填）" choices={roleNames} value={role.role} controls={{ booth: 'role-booth-field' }}
        onChange={(value) => setDraft({ ...role, role: value })} hint="切回一般玩家會清除攤位指派。" />
      <div id="role-booth-field" hidden={!needsBooth}>
        <Field id="role-booth-id" label="指派攤位（攤位人員必填）">
          <select id="role-booth-id" name="boothId" disabled={!needsBooth} required={needsBooth} value={role.boothId} onChange={(event) => setDraft({ ...role, boothId: event.target.value })}>
            <option value="">請選擇指派攤位</option>{boothChoices}
          </select>
        </Field>
      </div>
    </ActionForm>
  );
}

function BadgeForm({ player }) {
  const [uid, setUid] = useState('');
  return (
    <ActionForm id="badge-form" title="玩家 NFC 名牌" action="replaceBadge" submitLabel="儲存名牌綁定">
      <input type="hidden" name="playerId" value={player.id} />
      <p>目前 UID：{player.badgeUid ?? '—'}</p>
      <input type="hidden" name="expectedUid" value={player.badgeUid ?? ''} />
      <Field id="badge-uid" label="新 NFC UID（14 個十六進位字元）">
        <input id="badge-uid" name="uid" required maxLength={26}
          pattern={'(?:[0-9A-Fa-f]{2}[ :\\-]?){6}[0-9A-Fa-f]{2}'}
          value={uid} onChange={(event) => setUid(event.target.value)}
          {...identifierProps} />
      </Field>
    </ActionForm>
  );
}

function InventoryForm({ player }) {
  const [draft, setDraft] = useState({ resource: 'coins', direction: 'grant', amount: '1', reason: '' });
  const patch = (key, value) => setDraft({ ...draft, [key]: value });
  const current = inventoryQuantity(player, draft.resource);
  const planet = Object.hasOwn(planetNames, draft.resource);
  const revoking = draft.direction === 'revoke';
  return (
    <ActionForm id="inventory-form" title="玩家資源" action="adjustInventory" submitLabel={revoking ? '收回資源' : '發放資源'}
      submitDisabled={current == null || (revoking && current === 0) || (!revoking && planet && current === 1)}>
      <input type="hidden" name="playerId" value={player.id} />
      <div className="form-grid">
        <Field id="inventory-resource" label="資源">
          <select id="inventory-resource" name="resource" value={draft.resource} onChange={(event) => patch('resource', event.target.value)}>
            {Object.entries(inventoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            <optgroup label="星球">{Object.entries(planetNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>
          </select>
        </Field>
        <Field id="inventory-direction" label="操作">
          <select id="inventory-direction" name="direction" value={draft.direction} onChange={(event) => patch('direction', event.target.value)}>
            <option value="grant">發放</option>
            <option value="revoke">收回</option>
          </select>
        </Field>
        {planet ? <input type="hidden" name="amount" value="1" /> :
          <NumberField id="inventory-amount" name="amount" label="數量" min={1}
            max={revoking ? Math.max(1, Math.min(current ?? 0, 10000)) : 10000}
            value={draft.amount} onChange={(event) => patch('amount', event.target.value)} />}
      </div>
      <p>目前持有：{current == null ? '—' : number(current)}</p>
      <input type="hidden" name="expected" value={current ?? ''} />
      <Field id="inventory-reason" label="原因（必填）">
        <input id="inventory-reason" name="reason" required maxLength={200} value={draft.reason} onChange={(event) => patch('reason', event.target.value)} />
      </Field>
    </ActionForm>
  );
}

const rosterPageSize = 25;
const economyStats = [
  ['coins', inventoryNames.coins], ['packs', inventoryNames.packs],
  ['points', inventoryNames.points], ['handTotal', '手牌總數'],
];
const progressStats = [
  ...economyStats,
  ['planets', '星球'], ['friends', '好友'], ['checkpoints', '打卡小石'], ['missions', '完成任務'],
];
const handCards = ['scissors', 'rock', 'paper', 'wild'];
const unlockTotals = { planets: 42, checkpoints: 42, missions: 6 };
const rosterStats = [
  ...economyStats, ...handCards.map((key) => [key, inventoryNames[key]]),
  ['planets', '星球解鎖'], ['checkpoints', '打卡小石'], ['missions', '完成任務'],
];
const rosterColumns = [['name', '玩家'], ['checkedIn', '報到'], ['role', '角色'], ...rosterStats];
const rosterHeadings = rosterColumns.map(([, label]) => label);
const rosterNameOrder = new Intl.Collator('zh-TW', { numeric: true, sensitivity: 'base' });

function progressValue(value, key) {
  if (value == null) return '—';
  return Object.hasOwn(unlockTotals, key) ? `${number(value)}/${unlockTotals[key]}` : number(value);
}

function rosterValue(player, key) {
  if (key === 'name') return player.name || player.id;
  if (key === 'checkedIn') return Number(Boolean(player.checkedIn));
  if (key === 'role') return nameOf(roleNames, player.role);
  return inventoryQuantity(player, key);
}

function CheckInStatus({ player }) {
  return <span className={`chip ${player.checkedIn ? 'positive' : 'secondary'}`}>{player.checkedIn ? '已報到' : '未報到'}</span>;
}

function focusHeading(node) { node?.focus(); }

function PlayerWorkspace({ player, close }) {
  const heading = useId();
  return (
    <div className="view" id="player-workspace" aria-labelledby={heading}>
      <section className="card player-summary" aria-labelledby={heading}>
        <button type="button" className="button outlined" onClick={close}>返回玩家名單</button>
        <h2 id={heading} tabIndex={-1} ref={focusHeading}>{player.name || player.id}</h2>
        <code>{player.id}</code>
        <div className="player-meta"><CheckInStatus player={player} /><span>{nameOf(roleNames, player.role)}</span>
          {player.role === 'booth' ? <span>{nameOf(boothNames, player.boothId)}</span> : null}
        </div>
        <dl className="stats">{progressStats.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{progressValue(player[key], key)}</dd></div>)}</dl>
        <section className="player-hand" aria-labelledby={`${heading}-hand`}>
          <h3 id={`${heading}-hand`}>手牌明細</h3>
          <dl className="stats">{handCards.map((key) => {
            const quantity = inventoryQuantity(player, key);
            return <div key={key}><dt>{inventoryNames[key]}</dt><dd>{quantity === null ? '—' : number(quantity)}</dd></div>;
          })}</dl>
        </section>
      </section>
      <div className="two-columns"><BadgeForm player={player} /><InventoryForm player={player} /></div>
      <RoleForm player={player} />
      <details className="card player-extra">
        <summary>其他玩家獎勵與任務</summary>
        <div className="two-columns"><RewardsForm playerId={player.id} /><div className="view"><PhotoForm playerId={player.id} /><BoothForm playerId={player.id} /></div></div>
      </details>
    </div>
  );
}

export function Players() {
  const { state } = useDashboard();
  const [query, setQuery] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [role, setRole] = useState('');
  const [sort, setSort] = useState({ column: 0, direction: 'ascending' });
  const [page, setPage] = useState(0);
  const [playerId, setPlayerId] = useState(null);
  const focusSearch = useRef(false);
  const players = state?.players ?? none;
  const player = players.find(({ id }) => id === playerId);
  if (player) {
    return <PlayerWorkspace key={player.id} player={player} close={() => {
      focusSearch.current = true;
      setPlayerId(null);
    }} />;
  }

  const term = query.trim().toLowerCase();
  const uid = term.replace(/[ :\-]/g, '');
  const searchingUid = /^[a-f0-9]+$/.test(uid);
  const filtered = players.filter((item) => (
    (!checkIn || Boolean(item.checkedIn) === (checkIn === 'in')) &&
    (!role || item.role === role) &&
    (!term || item.id.toLowerCase().includes(term) || item.name?.toLowerCase().includes(term) ||
      (searchingUid && item.badgeUid?.toLowerCase().includes(uid)))
  ));
  const [sortKey, sortLabel] = rosterColumns[sort.column];
  const multiplier = sort.direction === 'ascending' ? 1 : -1;
  filtered.sort((a, b) => {
    const left = rosterValue(a, sortKey), right = rosterValue(b, sortKey);
    if (left == null && right != null) return 1;
    if (right == null && left != null) return -1;
    const primary = typeof left === 'string' && typeof right === 'string'
      ? rosterNameOrder.compare(left, right)
      : (left ?? 0) - (right ?? 0);
    return primary * multiplier || rosterNameOrder.compare(a.name || a.id, b.name || b.id)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / rosterPageSize));
  const current = Math.min(page, pageCount - 1);
  const offset = current * rosterPageSize;
  const shown = filtered.slice(offset, offset + rosterPageSize);
  function updateFilter(set, value) { set(value); setPage(0); }
  function sortBy(column) {
    setSort((previous) => ({
      column,
      direction: previous.column === column && previous.direction === 'ascending' ? 'descending' : 'ascending',
    }));
    setPage(0);
  }
  return (
    <div className="view">
      <Card title="玩家名單" action={state ? <span className="chip secondary">{number(players.length)} 位玩家</span> : null}>
        <div className="roster-filters" role="search" aria-label="搜尋玩家名單">
          <Field id="player-search" label="搜尋玩家">
            <input id="player-search" type="search" placeholder="姓名、玩家 ID 或 NFC UID" value={query}
              onChange={(event) => updateFilter(setQuery, event.target.value)} {...identifierProps}
              ref={(node) => { if (node && focusSearch.current) { focusSearch.current = false; node.focus(); } }} />
          </Field>
          <Field id="player-checkin-filter" label="報到">
            <select id="player-checkin-filter" value={checkIn} onChange={(event) => updateFilter(setCheckIn, event.target.value)}>
              <option value="">全部</option><option value="in">已報到</option><option value="out">未報到</option>
            </select>
          </Field>
          <Field id="player-role-filter" label="角色">
            <select id="player-role-filter" value={role} onChange={(event) => updateFilter(setRole, event.target.value)}>
              <option value="">全部</option>
              {Object.entries(roleNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        <div className="roster-results">
          <DataTable caption="玩家搜尋結果" empty={state ? (players.length ? '沒有符合條件的玩家。' : '尚無測試玩家。') : unloaded}
            headings={rosterHeadings} sort={{ ...sort, onChange: sortBy }}
            rows={shown.map((item) => [item.id,
              <button type="button" className="roster-player" onClick={() => setPlayerId(item.id)}>
                <strong>{item.name || item.id}</strong><small>{item.badgeUid ?? (item.name !== item.id ? item.id : '')}</small>
              </button>,
              <CheckInStatus player={item} />, nameOf(roleNames, item.role),
              ...rosterStats.map(([key]) => progressValue(rosterValue(item, key), key))])} />
        </div>
        {state ? <nav className="roster-pages" aria-label="玩家名單分頁">
          <span role="status"><span className="sr-only">{sortLabel}，{sort.direction === 'ascending' ? '升冪' : '降冪'}，</span>{filtered.length ? `${number(offset + 1)}–${number(offset + shown.length)} / ${number(filtered.length)}` : '0 位玩家'}</span>
          <button type="button" className="button outlined" disabled={current === 0} onClick={() => setPage(current - 1)}>上一頁</button>
          <button type="button" className="button outlined" disabled={current + 1 >= pageCount} onClick={() => setPage(current + 1)}>下一頁</button>
        </nav> : null}
      </Card>
      <details className="card player-extra"><summary>全體卡包獎勵</summary><RewardsForm playerId="all" /></details>
    </div>
  );
}

function TagUidField({ id }) {
  return (
    <Field id={id} label="NTAG UID（14 個十六進位字元）">
      <input id={id} name="uid" required maxLength={26}
        pattern={'(?:[0-9A-Fa-f]{2}[ :\\-]?){6}[0-9A-Fa-f]{2}'} {...identifierProps} />
    </Field>
  );
}

export function Stations() {
  const { state, writable, announce } = useDashboard();
  const [draft, setDraft] = useDraft('station', defaultStation);
  const nameInput = useRef(null);
  const stationIdInput = useRef(null);
  const patch = (key, value) => setDraft({ ...draft, [key]: value });
  const edit = (station) => {
    setDraft({ ...station, stationId: station.id });
    nameInput.current?.focus();
    announce(`已載入 ${station.name}，尚未儲存。`);
  };
  return (
    <div className="view">
      <Card title="發卡站狀態">
        <DataTable caption="發卡站庫存與領取規則" empty={state ? '尚無發卡站。' : unloaded}
          headings={['發卡站', 'ID', 'NTAG UID', '每次卡包', '每人上限', '庫存', '狀態', '操作']}
          rows={(state?.stations ?? none).map((station) => [station.id, station.name, station.id, station.boundUids?.join('、') || '—', number(station.packs), number(station.limit), number(station.remaining),
            <span className={`chip ${station.open ? 'positive' : 'secondary'}`}>{station.open ? '開放' : '關閉'}</span>,
            <button className="button tonal compact" type="button" disabled={!writable} aria-label={`編輯發卡站 ${station.id}`} onClick={() => edit(station)}>編輯</button>])} />
      </Card>
      <ActionForm id="station-form" title="建立或更新發卡站" action="station" submitLabel="儲存發卡站"
        tools={<button type="button" className="button tonal" disabled={!writable} onClick={() => {
          setDraft(defaultStation);
          stationIdInput.current?.focus();
        }}>建立新站</button>}>
        <div className="form-grid station-fields">
          <Field id="station-id" label="發卡站 ID（必填）" help="station- 開頭，後接 1–40 個英文字母、數字或連字號。相同 ID 更新原站。">
            <input ref={stationIdInput} id="station-id" name="stationId" value={draft.stationId} onChange={(event) => patch('stationId', event.target.value)}
              required pattern={String.raw`station-[a-zA-Z0-9\-]{1,40}`} maxLength={48} aria-describedby="station-id-help" {...identifierProps} />
          </Field>
          <Field id="station-name" label="站名（必填）">
            <input ref={nameInput} id="station-name" name="name" maxLength={120} value={draft.name} onChange={(event) => patch('name', event.target.value)} required />
          </Field>
          {[
            ['packs', '每次卡包數（1–100）', 1, 100], ['limit', '每人領取上限（1–100）', 1, 100], ['remaining', '剩餘庫存（0–100,000）', 0, 100000],
          ].map(([name, label, min, max]) => <NumberField key={name} id={`station-${name}`} name={name} label={label} min={min} max={max}
            value={draft[name]} onChange={(event) => patch(name, event.target.value)} />)}
          <div className="check-field"><input id="station-open" name="open" type="checkbox" checked={draft.open} onChange={(event) => patch('open', event.target.checked)} /><label htmlFor="station-open">開放領取</label></div>
        </div>
      </ActionForm>
      <ActionForm id="station-tag-form" title="綁定發卡站 NTAG" action="bindStationTag" submitLabel="綁定 NTAG">
        <div className="form-grid station-fields">
          <Field id="station-tag-target" label="發卡站（必填）">
            <select id="station-tag-target" name="stationId" defaultValue="" required>
              <option value="" disabled>選擇發卡站</option>
              {(state?.stations ?? none).map(({ id, name }) => <option key={id} value={id}>{name}（{id}）</option>)}
            </select>
          </Field>
          <TagUidField id="station-tag-uid" />
        </div>
      </ActionForm>
    </div>
  );
}

export function Checkpoints() {
  const { state } = useDashboard();
  return (
    <div className="view">
      <Card title="掃描狀態">
        <DataTable caption="打卡小石實際掃描狀態" empty={state ? '尚無打卡資料。' : unloaded}
          headings={['編號', '區域', 'NTAG UID', '掃描次數', '收集數', '最近掃描']}
          rows={(state?.checkpoints ?? none).map((checkpoint) => [checkpoint.number, checkpoint.number, checkpoint.area, checkpoint.boundUids?.join('、') || '—', number(checkpoint.scans),
            typeof checkpoint.collected === 'boolean' ? (checkpoint.collected ? '已收集' : '未收集') : number(checkpoint.collected), time(checkpoint.lastScan)])} />
      </Card>
      <ActionForm id="checkpoint-tag-form" title="綁定打卡小石 NTAG" action="bindCheckpointTag" submitLabel="綁定 NTAG">
        <div className="form-grid station-fields">
          <Field id="checkpoint-tag-target" label="打卡小石（必填）">
            <select id="checkpoint-tag-target" name="checkpointNumber" defaultValue="" required>
              <option value="" disabled>選擇打卡小石</option>
              {(state?.checkpoints ?? none).map(({ number, area }) => <option key={number} value={number}>{number} · {area}</option>)}
            </select>
          </Field>
          <TagUidField id="checkpoint-tag-uid" />
        </div>
      </ActionForm>
    </div>
  );
}

export function Audit() {
  const { state } = useDashboard();
  return (
    <Card title="管理操作" action={<span className="chip secondary">最新在前</span>}>
      <DataTable caption="後端保存的管理操作紀錄" empty={state ? '尚無操作紀錄。' : unloaded}
        headings={['時間', '操作', '對象', '細節']}
        rows={(state?.audit ?? none).map((entry, index, entries) => [`${entry.at}:${entries.length - index}`, time(entry.at), entry.action, entry.playerId || '全域',
          <code>{typeof entry.detail === 'object' ? JSON.stringify(entry.detail) : entry.detail}</code>])} />
    </Card>
  );
}

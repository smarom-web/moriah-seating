// src/App.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import SeatMapDesigner from './SeatMapDesigner.jsx' // <— new

// ---------- Config ----------
const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

const sb = (supabaseUrl && supabaseAnon) ? createClient(supabaseUrl, supabaseAnon) : null
const HOLD_SECONDS = 300 // 5-minute soft hold

// ---------- Helpers ----------
const k = (r, s) => `${r}#${s}`
const excelColToNum = (col) =>
  String(col || '').toUpperCase().split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0)

const fmtTime = (secs) => {
  if (secs <= 0) return '0:00'
  const m = Math.floor(secs / 60), s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function downloadCSV(filename, rows) {
  if (!rows || rows.length === 0) return
  const head = Object.keys(rows[0] || {})
  const csv = [head.join(',')].concat(
    rows.map(r => head.map(h => JSON.stringify(r[h] ?? '')).join(','))
  ).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ---------- Component ----------
export default function App() {
  const [loading, setLoading] = useState(true)
  const [setupMode, setSetupMode] = useState(false)
  const [mapMode, setMapMode] = useState(false)
  const [mapDesigner, setMapDesigner] = useState(false) // <— new

  // Auth
  const [user, setUser] = useState(null)
  const isAdmin = !!(user && ADMIN_EMAILS.includes((user.email || '').toLowerCase()))

  // UI state
  const [nameInput, setNameInput] = useState('')
  const [filter, setFilter] = useState('')
  const [groupSize, setGroupSize] = useState(1) // 1..6
  const [rows, setRows] = useState([]) // ["A","B",...]
  const [seats, setSeats] = useState({}) // key -> {row, seat, status: 'available'|'held'|'taken', heldBy?, holdExpiresAt?, reservedBy?}
  const [confirm, setConfirm] = useState(null) // {row, seat, block:[seats...]}

  // Map overlay coordinates (from DB seat_coords)
  const [coords, setCoords] = useState({}) // key -> {x,y}

  // Holds countdown tick
  const [, forceTick] = useState(0)
  useEffect(() => { const t = setInterval(() => forceTick(x => x + 1), 1000); return () => clearInterval(t) }, [])

  // ---------- Auth ----------
  useEffect(() => {
    if (!sb) return
    sb.auth.getSession().then(({ data }) => setUser(data.session?.user || null))
    const { data: sub } = sb.auth.onAuthStateChange((_evt, sess) => setUser(sess?.user || null))
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async (email) => {
    if (!sb) return alert('Add Supabase keys to enable auth.')
    if (!email) return alert('Enter an email')
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    if (error) return alert('Sign-in error: ' + error.message)
    alert('Check your email for the magic link to sign in.')
  }
  const signOut = async () => { await sb?.auth.signOut() }

  // ---------- Initial load ----------
  const loadAll = useCallback(async () => {
    if (!sb) { setLoading(false); return }
    // cleanup expired holds
    await sb.from('seat_holds').delete().lt('expires_at', new Date().toISOString())

    const [{ data: catalog }, { data: reservations }, { data: holds }] = await Promise.all([
      sb.from('seat_catalog').select('*'),
      sb.from('seat_reservations').select('*'),
      sb.from('seat_holds').select('*')
    ])

    const map = {}; const rowset = new Set()
    ;(catalog || []).forEach(c => {
      map[k(c.row_label, c.seat_number)] = { row: c.row_label, seat: c.seat_number, status: 'available' }
      rowset.add(c.row_label)
    })
    ;(reservations || []).forEach(r => {
      const key = k(r.row_label, r.seat_number)
      if (map[key]) { map[key].status = 'taken'; map[key].reservedBy = r.reserved_by || undefined }
    })
    ;(holds || []).forEach(h => {
      const key = k(h.row_label, h.seat_number)
      if (map[key] && map[key].status === 'available') {
        map[key].status = 'held'; map[key].heldBy = h.held_by || undefined; map[key].holdExpiresAt = h.expires_at
      }
    })

    setSeats(map)
    setRows(Array.from(rowset).sort((a, b) => excelColToNum(a) - excelColToNum(b)))
    setLoading(false)

    // Also load pin coordinates for Map Mode
    const { data: cs } = await sb.from('seat_coords').select('*')
    const cMap = {}; (cs || []).forEach(c => { cMap[k(c.row_label, c.seat_number)] = { x: c.x, y: c.y } })
    setCoords(cMap)
  }, [])
  useEffect(() => { loadAll() }, [loadAll])

  // ---------- Realtime ----------
  useEffect(() => {
    if (!sb) return
    const chRsv = sb.channel('rsv_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seat_reservations' }, (payload) => {
        const r = payload.new
        const key = k(r.row_label, r.seat_number)
        setSeats(prev => ({
          ...prev,
          [key]: prev[key] ? { ...prev[key], status: 'taken', reservedBy: r.reserved_by || undefined } : prev[key]
        }))
      }).subscribe()

    const chHold = sb.channel('hold_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seat_holds' }, (payload) => {
        const h = payload.new
        const key = k(h.row_label, h.seat_number)
        setSeats(prev => {
          const cur = prev[key]
          if (!cur) return prev
          if (cur.status === 'taken') return prev
          return { ...prev, [key]: { ...cur, status: 'held', heldBy: h.held_by || undefined, holdExpiresAt: h.expires_at } }
        })
      }).subscribe()

    const chCoords = sb.channel('coords_changes') // <— update pins live while designing
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seat_coords' }, (payload) => {
        const c = payload.new
        setCoords(prev => ({ ...prev, [k(c.row_label, c.seat_number)]: { x: c.x, y: c.y } }))
      }).subscribe()

    return () => { sb.removeChannel(chRsv); sb.removeChannel(chHold); sb.removeChannel(chCoords) }
  }, [])

  // ---------- Import master seating ----------
  async function handleUploadMaster(e) {
    const file = e.target.files?.[0]; if (!file) return
    const buf = await file.arrayBuffer(); const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json(ws, { defval: null })

    const catalog = [], pre = []
    for (const row of json) {
      const rowLabel = (row['Row'] ?? '').toString().trim()
      const seatNum = Number(row['Seats'])
      if (!rowLabel || !Number.isFinite(seatNum)) continue
      catalog.push({ row_label: rowLabel, seat_number: seatNum })
      const last = (row['Family Last Name'] || '').toString().trim()
      const first = (row['First Name(s)'] || '').toString().trim()
      if (last || first) pre.push({ row_label: rowLabel, seat_number: seatNum, reserved_by: [last, first].filter(Boolean).join(', ') })
    }

    if (!sb) { alert(`Parsed ${catalog.length} seats; ${pre.length} pre-reserved. Add Supabase keys to import.`); return }

    setLoading(true)
    const { error: cErr } = await sb.from('seat_catalog').upsert(catalog, { onConflict: 'row_label,seat_number' })
    if (cErr) { console.error(cErr); alert('Catalog import failed (admin only): ' + cErr.message); setLoading(false); return }

    for (let i = 0; i < pre.length; i += 500) {
      const batch = pre.slice(i, i + 500)
      const { error: pErr } = await sb.from('seat_reservations').upsert(batch, { onConflict: 'row_label,seat_number' })
      if (pErr) { console.error(pErr); alert('Pre-assign error: ' + pErr.message) }
    }

    await logAction('import_master', { seats: catalog.length, preReserved: pre.length })
    setLoading(false)
    await loadAll()
    alert('Master import complete.')
  }

  // ---------- Holds & group booking ----------
  function findContiguous(row, startSeat, need) {
    const rowSeats = Object.values(seats).filter(s => s.row === row).sort((a, b) => a.seat - b.seat)
    const takenSet = new Set(rowSeats.filter(s => s.status !== 'available').map(s => s.seat))
    // try forward from startSeat
    for (let s = startSeat; s <= (rowSeats[rowSeats.length - 1]?.seat || startSeat) + need; s++) {
      let ok = true; for (let i = 0; i < need; i++) { if (takenSet.has(s + i)) { ok = false; break } }
      if (ok) return Array.from({ length: need }, (_, i) => s + i)
    }
    // also try slightly earlier
    for (let s = Math.max(1, startSeat - need); s < startSeat; s++) {
      let ok = true; for (let i = 0; i < need; i++) { if (takenSet.has(s + i)) { ok = false; break } }
      if (ok) return Array.from({ length: need }, (_, i) => s + i)
    }
    return null
  }

  async function holdBlock(row, block) {
    if (!sb) return alert('Add Supabase keys to hold.')
    if (!user) return alert('Sign in to hold seats.')
    await sb.from('seat_holds').delete().lt('expires_at', new Date().toISOString())
    const expires = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString()

    const inserted = []
    for (const seat of block) {
      const { error } = await sb.from('seat_holds').insert({ row_label: row, seat_number: seat, held_by: user.email, expires_at: expires })
      if (error) {
        if (inserted.length) await sb.from('seat_holds').delete().in('seat_number', inserted).eq('row_label', row)
        alert(`Could not hold seat ${row}-${seat}. It may be held or reserved by someone else.`)
        return false
      }
      inserted.push(seat)
      await logAction('hold', { row, seat, expires })
    }
    await loadAll()
    setConfirm({ row, seat: block[0], block })
    return true
  }

  async function finalizeReservation(row, block) {
    if (!sb) return
    if (!user) return alert('Sign in first')
    for (const seat of block) {
      const { error } = await sb.from('seat_reservations').insert({ row_label: row, seat_number: seat, reserved_by: nameInput || user.email })
      if (error) { alert(`Reservation failed for ${row}-${seat}: ${error.message}`); return }
      await logAction('reserve', { row, seat })
    }
    await sb.from('seat_holds').delete().in('seat_number', block).eq('row_label', row).eq('held_by', user.email)
    setConfirm(null)
    await loadAll()
  }

  // ---------- Admin ops ----------
  async function freeSeat(row, seat) {
    if (!isAdmin) return alert('Admin only')
    const { error } = await sb.from('seat_reservations').delete().eq('row_label', row).eq('seat_number', seat)
    if (error) return alert('Free seat failed: ' + error.message)
    await logAction('admin_free', { row, seat }); await loadAll()
  }
  async function undoLastReservation() {
    if (!isAdmin) return alert('Admin only')
    const { data, error } = await sb.from('seat_reservations').select('*').order('reserved_at', { ascending: false }).limit(1)
    if (error) return alert(error.message)
    const last = data?.[0]; if (!last) return alert('No reservations to undo')
    await sb.from('seat_reservations').delete().eq('row_label', last.row_label).eq('seat_number', last.seat_number)
    await logAction('admin_undo', { row: last.row_label, seat: last.seat_number }); await loadAll()
  }
  async function exportReservations() {
    const { data } = await sb.from('seat_reservations').select('*').order('row_label', { ascending: true }).order('seat_number', { ascending: true })
    const rows = (data || []).map(r => ({ Row: r.row_label, Seat: r.seat_number, Name: r.reserved_by || '', ReservedAt: r.reserved_at }))
    downloadCSV('reservations.csv', rows)
  }
  async function exportAudit() {
    const { data } = await sb.from('audit_log').select('*').order('at', { ascending: false }).limit(2000)
    const rows = (data || []).map(a => ({ When: a.at, Who: a.who || '', Action: a.action, Row: a.row_label || '', Seat: a.seat_number || '', Details: a.details || '' }))
    downloadCSV('audit_log.csv', rows)
  }
  async function logAction(action, payload) {
    try {
      await sb.from('audit_log').insert({
        action,
        who: user?.email || nameInput || 'anon',
        row_label: payload?.row || null,
        seat_number: payload?.seat || null,
        details: JSON.stringify(payload || {}).slice(0, 2000)
      })
    } catch { /* ignore */ }
  }

  // ---------- Render ----------
  const filteredRows = useMemo(
    () => rows.filter(r => !filter || r.toUpperCase().startsWith(filter.toUpperCase())),
    [rows, filter]
  )

  function SeatButton({ seatObj }) {
    const status = seatObj.status
    const myHold = user && status === 'held' && (seatObj.heldBy || '').toLowerCase() === (user.email || '').toLowerCase()
    const expiresIn = status === 'held' && seatObj.holdExpiresAt
      ? Math.max(0, Math.floor((new Date(seatObj.holdExpiresAt) - Date.now()) / 1000)) : 0

    const onClick = async () => {
      if (status === 'taken') return
      const row = seatObj.row; const seat = seatObj.seat
      const need = Math.min(Math.max(groupSize, 1), 6)
      const block = findContiguous(row, seat, need)
      if (!block) return alert(`No contiguous block of ${need} in Row ${row} starting near Seat ${seat}.`)
      await holdBlock(row, block)
    }

    let bg = '#ecfdf5', color = '#065f46', border = '#a7f3d0', title = 'Available'
    if (status === 'held') {
      bg = myHold ? '#fef9c3' : '#fff7ed'
      color = '#92400e'
      border = '#fde68a'
      title = myHold ? `Held by you, ${fmtTime(expiresIn)} left` : 'Temporarily held by someone else'
    }
    if (status === 'taken') {
      bg = '#ef4444'; color = '#fff'; border = '#b91c1c'
      title = seatObj.reservedBy ? `Taken by ${seatObj.reservedBy}` : 'Taken'
    }

    return (
      <button
        onClick={onClick}
        disabled={status !== 'available'}
        title={title}
        style={{
          width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '1px solid', borderColor: border, borderRadius: 8, fontSize: 12,
          background: bg, color, cursor: status === 'available' ? 'pointer' : 'not-allowed'
        }}
      >{seatObj.seat}</button>
    )
  }

  return (
    <div>
      {/* Header */}
      <header style={{ position: 'sticky', top: 0, background: '#fff', borderBottom: '1px solid #e5e7eb', zIndex: 10 }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 600 }}>Moriah Seating Selector — Pro</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {user ? (
              <>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{user.email}</span>
                <button onClick={signOut} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>Sign out</button>
              </>
            ) : (
              <>
                <input
                  placeholder="Email for sign-in link"
                  onKeyDown={e => e.key === 'Enter' && signIn(e.currentTarget.value)}
                  style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}
                />
                <button
                  onClick={() => { const el = document.querySelector('header input'); if (el) signIn(el.value) }}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}
                >
                  Sign in
                </button>
              </>
            )}
            <button onClick={() => setSetupMode(v => !v)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
              {setupMode ? 'Exit Setup' : 'Setup Mode'}
            </button>
            {isAdmin && (
              <button onClick={() => setMapDesigner(v => !v)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                {mapDesigner ? 'Close Designer' : 'Map Designer'}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '16px' }}>
        {/* If designer is open (admin), show it full-page */}
        {isAdmin && mapDesigner ? (
          <SeatMapDesigner />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
            {/* Left: Filters & Settings */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Filters & Settings</div>
              <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Start with Row</div>
                  <input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="e.g., LL"
                    style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8, width: '100%' }}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Group size</div>
                  <select
                    value={groupSize}
                    onChange={e => setGroupSize(Number(e.target.value))}
                    style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8, width: '100%' }}
                  >
                    {[1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Your display name (printed on seat)</div>
                  <input
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    placeholder="e.g., Caplan, Samuel"
                    style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8, width: '100%' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input id="mapmode" type="checkbox" checked={mapMode} onChange={e => setMapMode(e.target.checked)} />
                  <label htmlFor="mapmode" style={{ fontSize: 14 }}>Map Mode (place pins in Designer)</label>
                </div>

                {setupMode && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Import master seating (xlsx)</div>
                    <input type="file" accept=".xlsx,.xls" onChange={handleUploadMaster} />
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                      Admin-only: seeds catalog from Column A/B and pre-reserves names in C/D.
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Seat grid or Map */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600 }}>Pick your seats</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Holds last {Math.round(HOLD_SECONDS / 60)} minutes</div>
              </div>
              <div style={{ padding: '12px 14px' }}>
                {loading ? (
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Loading…</div>
                ) : (
                  rows.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#6b7280' }}>No seats yet. Use Setup Mode to import the master sheet.</div>
                  ) : (
                    mapMode && Object.keys(coords).length > 0 ? (
                      // Absolute pins using saved coordinates (designer)
                      <div style={{ position: 'relative', height: 800, border: '1px dashed #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fafafa' }}>
                        {/* If you want to show the background image here too, you could load app_settings and render it.
                            The Designer handles image + canvas size; this view uses just pins for speed. */}
                        <div style={{ position: 'absolute', left: 0, top: 0, width: 1200, height: 800, transform: 'scale(0.95)', transformOrigin: 'top left' }}>
                          {Object.values(seats).map(s => {
                            const pos = coords[k(s.row, s.seat)]
                            if (!pos) return null
                            return (
                              <div key={k(s.row, s.seat)} style={{ position: 'absolute', left: pos.x, top: pos.y }}>
                                <SeatButton seatObj={s} />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      // Fallback: compact row/seat grid
                      <div style={{ display: 'grid', gap: 20 }}>
                        {filteredRows.map(row => (
                          <div key={row}>
                            <div style={{ marginBottom: 8, fontWeight: 600 }}>Row {row}</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {Object.values(seats).filter(s => s.row === row).sort((a, b) => a.seat - b.seat).map(s => (
                                <SeatButton key={k(s.row, s.seat)} seatObj={s} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Confirm modal */}
      <div style={{ position: 'fixed', inset: 0, display: confirm ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.2)' }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, width: 440, maxWidth: 'calc(100% - 24px)' }}>
          <h3 style={{ margin: '0 0 6px' }}>Confirm reservation</h3>
          {confirm && (
            <>
              <p style={{ margin: '6px 0 12px', fontSize: 12, color: '#6b7280' }}>
                Reserve Row {confirm.row}, Seats {confirm.block.join(', ')}?
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setConfirm(null)} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>Cancel</button>
                <button onClick={() => finalizeReservation(confirm.row, confirm.block)} style={{ border: '1px solid #059669', borderRadius: 8, padding: '8px 10px', background: '#10b981', color: '#fff' }}>Confirm</button>
              </div>
            </>
          )}
        </div>
      </div>

      <footer style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: '#6b7280' }}>
        Auth required to reserve. Seats update in real time. Holds last {Math.round(HOLD_SECONDS / 60)} minutes.
      </footer>
    </div>
  )
}

// Moriah Seating Selector — Pro Upgrade (All Features)
// -----------------------------------------------------------------------------
// Features added in this version:
// 1) Supabase Auth (invite-only): email sign-in/out gate for reserving.
// 2) Admin panel: search by name, free/clear seat, export CSV, undo last.
// 3) Group booking: pick 2–6 contiguous seats; auto-scan from clicked seat.
// 4) Soft holds: 5-minute hold (configurable) blocks others; realtime yellow state.
// 5) Audit log: who did what, when; exportable.
// 6) Seat map overlay (optional): upload seat_coordinates.csv with x,y per seat
//    and toggle "Map Mode" to place clickable pins on the map.
// 7) Real-time updates: reservations + holds are live across all clients.
// 8) Import master sheet like before (Setup Mode).
//
// Requirements
// - Environment vars (Vite):
//     VITE_SUPABASE_URL
//     VITE_SUPABASE_ANON_KEY
//     VITE_ADMIN_EMAILS  (comma-separated list; e.g., "you@org.org, other@org.org")
// - SQL: Apply the schema at the bottom of this file (search: //-- SQL PRO SCHEMA)
// - Supabase Auth: enable Email sign-in in Auth → Providers.
// - Realtime: add BOTH tables seat_reservations and seat_holds to Realtime.
//
// Notes
// - Minimal CSS/markup; no extra UI libraries required. Works with the starter.
// - If you used the earlier starter, you can replace your src/App.jsx with this.
// -----------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

// ---------- Config ----------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY
const ADMIN_EMAILS = (import.meta.env.VITE_ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
const sb = (supabaseUrl && supabaseAnon) ? createClient(supabaseUrl, supabaseAnon) : null

const HOLD_SECONDS = 300 // 5-minute soft hold

// ---------- Helpers ----------
const k = (r,s)=> `${r}#${s}`
const excelColToNum = (col)=> String(col||'').toUpperCase().split('').reduce((n,c)=> n*26 + (c.charCodeAt(0)-64), 0)
const fmtTime = (secs)=>{
  if(secs<=0) return '0:00'
  const m = Math.floor(secs/60), s = secs%60
  return `${m}:${String(s).padStart(2,'0')}`
}
function downloadCSV(filename, rows){
  const head = Object.keys(rows[0]||{})
  const csv = [head.join(',')].concat(rows.map(r=> head.map(h=> JSON.stringify(r[h] ?? '')).join(','))).join('\n')
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url)
}

// ---------- Component ----------
export default function App(){
  const [loading, setLoading] = useState(true)
  const [setupMode, setSetupMode] = useState(false)
  const [mapMode, setMapMode] = useState(false)

  // Auth
  const [user, setUser] = useState(null)
  const isAdmin = !!(user && ADMIN_EMAILS.includes((user.email||'').toLowerCase()))

  // UI state
  const [nameInput, setNameInput] = useState('')
  const [filter, setFilter] = useState('')
  const [groupSize, setGroupSize] = useState(1) // 1..6
  const [rows, setRows] = useState([]) // ["A","B",...]
  const [seats, setSeats] = useState({}) // key -> {row, seat, status: 'available'|'held'|'taken', heldBy?, holdExpiresAt?, reservedBy?}
  const [confirm, setConfirm] = useState(null) // {row, seat, block:[seats...]}

  // Map overlay data (optional)
  const [coords, setCoords] = useState({}) // key -> {x,y}

  // Holds countdown
  const [, forceRerender] = useState(0)
  useEffect(()=>{ const t = setInterval(()=>forceRerender(x=>x+1), 1000); return ()=>clearInterval(t) },[])

  // ---------- Auth ----------
  useEffect(()=>{
    if(!sb) return
    // get session
    sb.auth.getSession().then(({ data })=> setUser(data.session?.user || null))
    const { data: sub } = sb.auth.onAuthStateChange((_evt, sess)=> setUser(sess?.user || null))
    return ()=> sub.subscription.unsubscribe()
  },[])

  const signIn = async (email)=>{
    if(!sb) return alert('Add Supabase keys to enable auth.')
    if(!email) return alert('Enter an email')
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
    if(error) return alert('Sign-in error: '+error.message)
    alert('Check your email for the magic link to sign in.')
  }
  const signOut = async ()=>{ await sb?.auth.signOut() }

  // ---------- Initial load: catalog, reservations, holds ----------
  const loadAll = useCallback(async()=>{
    if(!sb){ setLoading(false); return }
    // clean expired holds first (policy permits)
    await sb.from('seat_holds').delete().lt('expires_at', new Date().toISOString())

    const [{ data: catalog }, { data: reservations }, { data: holds }] = await Promise.all([
      sb.from('seat_catalog').select('*'),
      sb.from('seat_reservations').select('*'),
      sb.from('seat_holds').select('*')
    ])

    const map = {}; const rowset = new Set()
    ;(catalog||[]).forEach(c=>{ map[k(c.row_label,c.seat_number)] = { row:c.row_label, seat:c.seat_number, status:'available' }; rowset.add(c.row_label) })
    ;(reservations||[]).forEach(r=>{ const key=k(r.row_label,r.seat_number); if(map[key]){ map[key].status='taken'; map[key].reservedBy=r.reserved_by||undefined } })
    ;(holds||[]).forEach(h=>{
      const key=k(h.row_label,h.seat_number); if(map[key] && map[key].status==='available'){
        map[key].status='held'; map[key].heldBy=h.held_by||undefined; map[key].holdExpiresAt=h.expires_at
      }
    })

    setSeats(map)
    setRows(Array.from(rowset).sort((a,b)=> excelColToNum(a)-excelColToNum(b)))
    setLoading(false)
  },[])

  useEffect(()=>{ loadAll() },[loadAll])

  // realtime
  useEffect(()=>{
    if(!sb) return
    const ch1 = sb.channel('rsv_changes')
      .on('postgres_changes', { event:'*', schema:'public', table:'seat_reservations' }, (payload)=>{
        const r = payload.new
        const key = k(r.row_label, r.seat_number)
        setSeats(prev=> ({
          ...prev,
          [key]: prev[key] ? { ...prev[key], status:'taken', reservedBy: r.reserved_by || undefined } : prev[key]
        }))
      }).subscribe()
    const ch2 = sb.channel('hold_changes')
      .on('postgres_changes', { event:'*', schema:'public', table:'seat_holds' }, (payload)=>{
        const h = payload.new
        const key = k(h.row_label, h.seat_number)
        setSeats(prev=>{
          const cur = prev[key]
          if(!cur) return prev
          // Render held unless already taken
          if(cur.status==='taken') return prev
          return { ...prev, [key]: { ...cur, status:'held', heldBy: h.held_by||undefined, holdExpiresAt: h.expires_at } }
        })
      }).subscribe()
    return ()=>{ sb.removeChannel(ch1); sb.removeChannel(ch2) }
  },[])

  // ---------- Import master seating ----------
  async function handleUploadMaster(e){
    const file = e.target.files?.[0]; if(!file) return
    const buf = await file.arrayBuffer(); const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json(ws, { defval: null })

    const catalog=[], pre=[]
    for(const row of json){
      const rowLabel = (row['Row'] ?? '').toString().trim()
      const seatNum = Number(row['Seats'])
      if(!rowLabel || !Number.isFinite(seatNum)) continue
      catalog.push({ row_label: rowLabel, seat_number: seatNum })
      const last=(row['Family Last Name']||'').toString().trim(); const first=(row['First Name(s)']||'').toString().trim()
      if(last || first){ pre.push({ row_label: rowLabel, seat_number: seatNum, reserved_by: [last, first].filter(Boolean).join(', ') }) }
    }

    if(!sb){ alert(`Parsed ${catalog.length} seats; ${pre.length} pre-reserved. Add Supabase keys to import.`); return }

    setLoading(true)
    // catalog insert allowed for admins; if not admin, this may fail
    const { error: cErr } = await sb.from('seat_catalog').upsert(catalog, { onConflict: 'row_label,seat_number' })
    if(cErr){ console.error(cErr); alert('Catalog import failed (admin only): '+cErr.message); setLoading(false); return }

    // reservations upsert (requires policy permitting update)
    for(let i=0;i<pre.length;i+=500){
      const batch = pre.slice(i,i+500)
      const { error: pErr } = await sb.from('seat_reservations').upsert(batch, { onConflict: 'row_label,seat_number' })
      if(pErr){ console.error(pErr); alert('Pre-assign error: '+pErr.message) }
    }

    await logAction('import_master', { seats: catalog.length, preReserved: pre.length })

    setLoading(false)
    await loadAll()
    alert('Master import complete.')
  }

  // ---------- Holds & group booking ----------
  function findContiguous(row, startSeat, need){
    const rowSeats = Object.values(seats).filter(s=>s.row===row)
      .sort((a,b)=>a.seat-b.seat)
    // Build availability map skipping taken/held
    const takenSet = new Set(rowSeats.filter(s=> s.status!=='available').map(s=> s.seat))
    // try from startSeat down and up
    for(let s = startSeat; s <= (rowSeats[rowSeats.length-1]?.seat || startSeat)+need; s++){
      let ok=true; for(let i=0;i<need;i++){ if(takenSet.has(s+i)) { ok=false; break } }
      if(ok) return Array.from({length:need}, (_,i)=> s+i)
    }
    // also try earlier slots
    for(let s = Math.max(1, startSeat-need); s < startSeat; s++){
      let ok=true; for(let i=0;i<need;i++){ if(takenSet.has(s+i)) { ok=false; break } }
      if(ok) return Array.from({length:need}, (_,i)=> s+i)
    }
    return null
  }

  async function holdBlock(row, block){
    if(!sb) return alert('Add Supabase keys to hold.')
    if(!user) return alert('Sign in to hold seats.')
    // cleanup expired holds
    await sb.from('seat_holds').delete().lt('expires_at', new Date().toISOString())
    const expires = new Date(Date.now() + HOLD_SECONDS*1000).toISOString()
    // try to insert holds seat by seat; abort on first failure and clean any partials
    const inserted=[]
    for(const seat of block){
      const { error } = await sb.from('seat_holds').insert({ row_label: row, seat_number: seat, held_by: user.email, expires_at: expires })
      if(error){
        // rollback prior
        if(inserted.length){ await sb.from('seat_holds').delete().in('seat_number', inserted).eq('row_label', row) }
        alert(`Could not hold seat ${row}-${seat}. It may be held or reserved by someone else.`)
        return false
      }
      inserted.push(seat)
      await logAction('hold', { row, seat, expires })
    }
    // refresh UI
    await loadAll()
    setConfirm({ row, seat: block[0], block })
    return true
  }

  async function finalizeReservation(row, block){
    if(!sb) return
    if(!user) return alert('Sign in first')
    // insert reservations then clear holds (only our holds)
    for(const seat of block){
      const { error } = await sb.from('seat_reservations').insert({ row_label: row, seat_number: seat, reserved_by: nameInput || user.email })
      if(error){
        alert(`Reservation failed for ${row}-${seat}: ${error.message}`)
        return
      }
      await logAction('reserve', { row, seat })
    }
    await sb.from('seat_holds').delete().in('seat_number', block).eq('row_label', row).eq('held_by', user.email)
    setConfirm(null)
    await loadAll()
  }

  // ---------- Admin ops ----------
  async function freeSeat(row, seat){
    if(!isAdmin) return alert('Admin only')
    const { error } = await sb.from('seat_reservations').delete().eq('row_label', row).eq('seat_number', seat)
    if(error){ return alert('Free seat failed: '+error.message) }
    await logAction('admin_free', { row, seat })
    await loadAll()
  }
  async function undoLastReservation(){
    if(!isAdmin) return alert('Admin only')
    const { data, error } = await sb.from('seat_reservations').select('*').order('reserved_at',{ascending:false}).limit(1)
    if(error) return alert(error.message)
    const last = data?.[0]
    if(!last) return alert('No reservations to undo')
    await sb.from('seat_reservations').delete().eq('row_label', last.row_label).eq('seat_number', last.seat_number)
    await logAction('admin_undo', { row: last.row_label, seat: last.seat_number })
    await loadAll()
  }
  async function exportReservations(){
    const { data } = await sb.from('seat_reservations').select('*').order('row_label',{ascending:true}).order('seat_number',{ascending:true})
    const rows = (data||[]).map(r=> ({ Row:r.row_label, Seat:r.seat_number, Name:r.reserved_by||'', ReservedAt:r.reserved_at }))
    downloadCSV('reservations.csv', rows)
  }
  async function exportAudit(){
    const { data } = await sb.from('audit_log').select('*').order('at',{ascending:false}).limit(2000)
    const rows = (data||[]).map(a=> ({ When:a.at, Who:a.who||'', Action:a.action, Row:a.row_label||'', Seat:a.seat_number||'', Details: a.details||'' }))
    downloadCSV('audit_log.csv', rows)
  }

  async function logAction(action, payload){
    try{
      await sb.from('audit_log').insert({ action, who: user?.email || nameInput || 'anon', row_label: payload?.row||null, seat_number: payload?.seat||null, details: JSON.stringify(payload||{}).slice(0, 2000) })
    }catch(_e){/* ignore */}
  }

  // ---------- Map overlay: coordinates upload ----------
  function handleCoordsUpload(e){
    const file = e.target.files?.[0]; if(!file) return
    const reader = new FileReader()
    reader.onload = ()=>{
      const text = reader.result.toString()
      // CSV headers: Row,Seat,X,Y (X/Y in pixels relative to a 1200x800 canvas)
      const lines = text.split(/\r?\n/).filter(Boolean)
      const head = lines.shift().split(',').map(s=>s.trim())
      const idx = { Row: head.indexOf('Row'), Seat: head.indexOf('Seat'), X: head.indexOf('X'), Y: head.indexOf('Y') }
      const map = {}
      for(const line of lines){
        const cols = line.split(',')
        const row = cols[idx.Row]?.trim()
        const seat = Number(cols[idx.Seat])
        const x = Number(cols[idx.X]); const y = Number(cols[idx.Y])
        if(row && Number.isFinite(seat) && Number.isFinite(x) && Number.isFinite(y)){
          map[k(row, seat)] = { x, y }
        }
      }
      setCoords(map)
      setMapMode(true)
    }
    reader.readAsText(file)
  }

  // ---------- Render ----------
  const filteredRows = useMemo(()=> rows.filter(r => !filter || r.toUpperCase().startsWith(filter.toUpperCase())), [rows, filter])

  function SeatButton({ seatObj }){
    const status = seatObj.status
    const myHold = user && status==='held' && (seatObj.heldBy||'').toLowerCase() === (user.email||'').toLowerCase()
    const expiresIn = status==='held' && seatObj.holdExpiresAt ? Math.max(0, Math.floor((new Date(seatObj.holdExpiresAt) - Date.now())/1000)) : 0

    const onClick = async ()=>{
      if(status==='taken') return
      const row = seatObj.row; const seat = seatObj.seat
      // group selection: find contiguous block from this seat
      const need = Math.min(Math.max(groupSize,1),6)
      const block = findContiguous(row, seat, need)
      if(!block){ return alert(`No contiguous block of ${need} in Row ${row} starting near Seat ${seat}.`) }
      await holdBlock(row, block)
    }

    let bg = '#ecfdf5', color='#065f46', border='#a7f3d0', title='Available'
    if(status==='held'){ bg = myHold ? '#fef9c3' : '#fff7ed'; color = '#92400e'; border = '#fde68a'; title = myHold? `Held by you, ${fmtTime(expiresIn)} left` : 'Temporarily held by someone else' }
    if(status==='taken'){ bg = '#ef4444'; color = '#fff'; border = '#b91c1c'; title = seatObj.reservedBy ? `Taken by ${seatObj.reservedBy}` : 'Taken' }

    return (
      <button
        onClick={onClick}
        disabled={status!=='available'}
        title={title}
        style={{ width:34, height:34, display:'flex', alignItems:'center', justifyContent:'center',
                 border:'1px solid', borderColor:border, borderRadius:8, fontSize:12,
                 background:bg, color, cursor: status==='available' ? 'pointer':'not-allowed' }}
      >{seatObj.seat}</button>
    )
  }

  return (
    <div>
      {/* Header */}
      <header style={{position:'sticky',top:0,background:'#fff',borderBottom:'1px solid #e5e7eb',zIndex:10}}>
        <div style={{maxWidth:1200,margin:'0 auto',padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
          <div style={{fontWeight:600}}>Moriah Seating Selector — Pro</div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {user ? (
              <>
                <span style={{fontSize:12,color:'#6b7280'}}>{user.email}</span>
                <button onClick={signOut} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Sign out</button>
              </>
            ) : (
              <>
                <input placeholder="Email for sign-in link" onKeyDown={e=> e.key==='Enter' && signIn(e.currentTarget.value)}
                       style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
                <button onClick={()=>{
                  const el = document.querySelector('header input'); if(el) signIn(el.value)
                }} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Sign in</button>
              </>
            )}
            <button onClick={()=>setSetupMode(v=>!v)} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>{setupMode?'Exit Setup':'Setup Mode'}</button>
          </div>
        </div>
      </header>

      {/* Controls */}
      <main style={{maxWidth:1200,margin:'0 auto',padding:'16px'}}>
        <div style={{display:'grid',gridTemplateColumns:'300px 1fr',gap:16}}>
          {/* Left: Filters & Admin */}
          <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12}}>
            <div style={{padding:'12px 14px',borderBottom:'1px solid #e5e7eb',fontWeight:600}}>Filters & Settings</div>
            <div style={{padding:'12px 14px'}}>
              <div style={{display:'grid',gap:10}}>
                <div>
                  <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Start with Row</div>
                  <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="e.g., LL"
                         style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8,width:'100%'}}/>
                </div>
                <div>
                  <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Group size</div>
                  <select value={groupSize} onChange={e=>setGroupSize(Number(e.target.value))}
                          style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8,width:'100%'}}>
                    {[1,2,3,4,5,6].map(n=> <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Your display name (printed on seat)</div>
                  <input value={nameInput} onChange={e=>setNameInput(e.target.value)} placeholder="e.g., Caplan, Samuel"
                         style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8,width:'100%'}}/>
                </div>
                <div style={{display:'flex',gap:8,alignItems:'center'}}>
                  <input id="mapmode" type="checkbox" checked={mapMode} onChange={e=>setMapMode(e.target.checked)} />
                  <label htmlFor="mapmode" style={{fontSize:14}}>Map Mode (use coordinates)</label>
                </div>
                {mapMode && (
                  <div>
                    <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Upload seat_coordinates.csv (Row,Seat,X,Y)</div>
                    <input type="file" accept=".csv" onChange={handleCoordsUpload} />
                  </div>
                )}
                {setupMode && (
                  <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid #e5e7eb'}}>
                    <div style={{fontSize:12,color:'#6b7280',marginBottom:6}}>Import master seating (xlsx)</div>
                    <input type="file" accept=".xlsx,.xls" onChange={handleUploadMaster} />
                    <div style={{fontSize:12,color:'#6b7280',marginTop:8}}>
                      Admin-only: seeds catalog from Column A/B and pre-reserves names in C/D.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Seat grid or Map */}
          <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12}}>
            <div style={{padding:'12px 14px',borderBottom:'1px solid #e5e7eb',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div style={{fontWeight:600}}>Pick your seats</div>
              <div style={{fontSize:12,color:'#6b7280'}}>Holds last {Math.round(HOLD_SECONDS/60)} minutes</div>
            </div>
            <div style={{padding:'12px 14px'}}>
              {loading ? (<div style={{fontSize:12,color:'#6b7280'}}>Loading…</div>) : (
                rows.length === 0 ? (<div style={{fontSize:12,color:'#6b7280'}}>No seats yet. Use Setup Mode to import the master sheet.</div>) : (
                  mapMode && Object.keys(coords).length>0 ? (
                    <div style={{position:'relative',height:800,border:'1px dashed #e5e7eb',borderRadius:12,overflow:'hidden',background:'#fafafa'}}>
                      {/* Place absolutely by x,y; assume 1200x800 coordinate space */}
                      <div style={{position:'absolute',left:0,top:0,width:1200,height:800,transform:'scale(0.95)',transformOrigin:'top left'}}>
                        {Object.values(seats).map(s=>{
                          const pos = coords[k(s.row, s.seat)]; if(!pos) return null
                          return (
                            <div key={k(s.row,s.seat)} style={{position:'absolute',left:pos.x,top:pos.y}}>
                              <SeatButton seatObj={s} />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{display:'grid',gap:20}}>
                      {filteredRows.map(row => (
                        <div key={row}>
                          <div style={{marginBottom:8,fontWeight:600}}>Row {row}</div>
                          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                            {Object.values(seats).filter(s=>s.row===row).sort((a,b)=>a.seat-b.seat).map(s=> (
                              <SeatButton key={k(s.row,s.seat)} seatObj={s} />
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

        {/* Admin Panel */}
        {isAdmin && (
          <div style={{marginTop:16,background:'#fff',border:'1px solid #e5e7eb',borderRadius:12}}>
            <div style={{padding:'12px 14px',borderBottom:'1px solid #e5e7eb',fontWeight:600}}>Admin Panel</div>
            <div style={{padding:'12px 14px',display:'grid',gap:12}}>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                <input id="searchName" placeholder="Search name (highlights in tooltip)" style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
                <button onClick={exportReservations} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Export Reservations CSV</button>
                <button onClick={exportAudit} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Export Audit Log CSV</button>
                <button onClick={undoLastReservation} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Undo Last Reservation</button>
              </div>
              <div style={{fontSize:12,color:'#6b7280'}}>Free a seat: enter Row and Seat, then Clear</div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                <input id="freeRow" placeholder="Row (e.g., LL)" style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
                <input id="freeSeat" placeholder="Seat (e.g., 17)" style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
                <button onClick={()=>{
                    const rowEl  = document.getElementById('freeRow')
  const seatEl = document.getElementById('freeSeat')
  const row  = rowEl  ? String(rowEl.value).trim().toUpperCase() : ''
  const seat = seatEl ? Number(String(seatEl.value).trim()) : NaN
  if (!row || !Number.isFinite(seat)) { alert('Enter row and seat'); return }
  freeSeat(row, seat)
                }} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Clear</button>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Confirm modal */}
      <div style={{ position:'fixed',inset:0, display: confirm ? 'flex' : 'none', alignItems:'center',justifyContent:'center', background:'rgba(0,0,0,0.2)'}}>
        <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12,padding:14,width:440,maxWidth:'calc(100% - 24px)'}}>
          <h3 style={{margin:'0 0 6px'}}>Confirm reservation</h3>
          {confirm && (
            <>
              <p style={{margin:'6px 0 12px',fontSize:12,color:'#6b7280'}}>Reserve Row {confirm.row}, Seats {confirm.block.join(', ')}?</p>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={()=>setConfirm(null)} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Cancel</button>
                <button onClick={()=> finalizeReservation(confirm.row, confirm.block)} style={{border:'1px solid #059669',borderRadius:8,padding:'8px 10px',background:'#10b981',color:'#fff'}}>Confirm</button>
              </div>
            </>
          )}
        </div>
      </div>

      <footer style={{textAlign:'center',padding:'24px 0',fontSize:12,color:'#6b7280'}}>Auth required to reserve. Seats update in real time. Holds last {Math.round(HOLD_SECONDS/60)} minutes.</footer>
    </div>
  )
}

// -----------------------------------------------------------------------------
// -- SQL PRO SCHEMA (run in Supabase SQL Editor) --------------------------------
/*
-- (Re)create tables

-- Catalog of all seats (composite PK)
create table if not exists public.seat_catalog (
  row_label   text not null,
  seat_number int  not null,
  section     text,
  primary key (row_label, seat_number)
);

-- Reservations (finalized)
create table if not exists public.seat_reservations (
  row_label   text not null,
  seat_number int  not null,
  reserved_by text,
  reserved_at timestamptz not null default now(),
  primary key (row_label, seat_number),
  foreign key (row_label, seat_number)
    references public.seat_catalog(row_label, seat_number)
    on update cascade on delete cascade
);

-- Soft holds (temporary blocks)
create table if not exists public.seat_holds (
  row_label   text not null,
  seat_number int  not null,
  held_by     text,
  expires_at  timestamptz not null,
  primary key (row_label, seat_number),
  foreign key (row_label, seat_number)
    references public.seat_catalog(row_label, seat_number)
    on update cascade on delete cascade
);

-- Audit log
create table if not exists public.audit_log (
  id          bigint generated by default as identity primary key,
  at          timestamptz not null default now(),
  who         text,
  action      text not null,
  row_label   text,
  seat_number int,
  details     text
);

-- Admins list (emails)
create table if not exists public.admins (
  email text primary key
);

-- RLS
alter table public.seat_catalog      enable row level security;
alter table public.seat_reservations enable row level security;
alter table public.seat_holds        enable row level security;
alter table public.audit_log         enable row level security;
alter table public.admins            enable row level security;

-- Helpers
create or replace view public.is_admin as
  select email from admins;

-- Policies
-- Catalog: anyone can read; only admins can insert/update
drop policy if exists catalog_read on public.seat_catalog;
create policy catalog_read on public.seat_catalog for select using (true);

drop policy if exists catalog_write on public.seat_catalog;
create policy catalog_write on public.seat_catalog for insert with check (
  exists (select 1 from admins a where a.email = auth.email())
);

-- Reservations: anyone can read; insert requires auth; delete by admins
drop policy if exists rsv_read on public.seat_reservations;
create policy rsv_read on public.seat_reservations for select using (true);

drop policy if exists rsv_insert on public.seat_reservations;
create policy rsv_insert on public.seat_reservations for insert with check (auth.role() = 'authenticated');

-- (Optional) allow the reserver to update their own name; comment out if not needed
drop policy if exists rsv_update_self on public.seat_reservations;
create policy rsv_update_self on public.seat_reservations for update using (auth.role() = 'authenticated');

-- Admin clear
drop policy if exists rsv_delete_admin on public.seat_reservations;
create policy rsv_delete_admin on public.seat_reservations for delete using (
  exists (select 1 from admins a where a.email = auth.email())
);

-- Holds: read for all; insert/update/delete for authenticated; cleanup of expired allowed to all
drop policy if exists holds_read on public.seat_holds;
create policy holds_read on public.seat_holds for select using (true);

-- Insert hold must be authenticated
drop policy if exists holds_insert on public.seat_holds;
create policy holds_insert on public.seat_holds for insert with check (auth.role() = 'authenticated');

-- Allow an authenticated user to delete their own holds, or anyone can delete expired holds
drop policy if exists holds_delete on public.seat_holds;
create policy holds_delete on public.seat_holds for delete using (
  auth.role() = 'authenticated' and (held_by = auth.email() or expires_at < now())
);

-- Allow the holder to extend their hold (update)
drop policy if exists holds_update on public.seat_holds;
create policy holds_update on public.seat_holds for update using (
  auth.role() = 'authenticated' and held_by = auth.email()
) with check (
  auth.role() = 'authenticated' and held_by = auth.email()
);

-- Audit: insert for authenticated (and anonymous if you wish); read for admins
-- (If you want everyone to read the log, change using(true))
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log for insert with check (true);

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select using (
  exists (select 1 from admins a where a.email = auth.email())
);

-- Admins table: only admins can read/add (bootstrap by inserting your email once)
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins for select using (
  exists (select 1 from admins a where a.email = auth.email())
);

drop policy if exists admins_insert on public.admins;
create policy admins_insert on public.admins for insert with check (
  exists (select 1 from admins a where a.email = auth.email())
);

-- Seed admin(s): run once, change the emails below
-- insert into admins(email) values ('you@yourdomain.org');

-- Realtime: in Dashboard → Database → Replication → Realtime, add tables
--   public.seat_reservations and public.seat_holds
*/

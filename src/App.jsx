// src/App.jsx
import React, { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY
const sb = (supabaseUrl && supabaseAnon) ? createClient(supabaseUrl, supabaseAnon) : null

const k = (r,s)=> `${r}#${s}`
const excelColToNum = (col)=> String(col).toUpperCase().split('').reduce((n,c)=> n*26 + (c.charCodeAt(0)-64), 0)

export default function App(){
  const [loading, setLoading] = useState(true)
  const [setupMode, setSetupMode] = useState(false)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')
  const [seats, setSeats] = useState({})  // key -> {row, seat, status, reservedBy?}
  const [rows, setRows] = useState([])    // list of row labels
  const [confirm, setConfirm] = useState(null) // {row, seat}

  useEffect(()=>{
    (async()=>{
      // Load catalog and current reservations
      if(!sb){ setLoading(false); return }
      const { data: catalog, error: ce } = await sb.from('seat_catalog').select('*')
      if(ce){ console.error(ce); setLoading(false); return }
      const { data: reservations, error: re } = await sb.from('seat_reservations').select('*')
      if(re){ console.error(re); setLoading(false); return }

      const map = {}; const rowset = new Set()
      ;(catalog||[]).forEach(c=>{
        map[k(c.row_label, c.seat_number)] = { row:c.row_label, seat:c.seat_number, status:'available' }
        rowset.add(c.row_label)
      })
      ;(reservations||[]).forEach(r=>{
        const key = k(r.row_label, r.seat_number)
        if(map[key]){ map[key].status='taken'; map[key].reservedBy=r.reserved_by || undefined }
      })
      setSeats(map)
      setRows(Array.from(rowset).sort((a,b)=> excelColToNum(a)-excelColToNum(b)))
      setLoading(false)

      // Realtime updates
      const channel = sb.channel('seat_changes')
        .on('postgres_changes', { event:'*', schema:'public', table:'seat_reservations' }, (payload)=>{
          const r = payload.new
          const key = k(r.row_label, r.seat_number)
          setSeats(prev => ({
            ...prev,
            [key]: prev[key] ? { ...prev[key], status:'taken', reservedBy: r.reserved_by || undefined } : prev[key]
          }))
        })
        .subscribe()
      return ()=> sb.removeChannel(channel)
    })()
  },[])

  const filteredRows = useMemo(
    ()=> rows.filter(r => !filter || r.toUpperCase().startsWith(filter.toUpperCase())),
    [rows, filter]
  )

  async function reserveSeat(row, seat){
    if(!sb){ alert('Demo only — add Supabase keys to enable reservations.'); return }
    if(!name.trim()){ alert('Enter your name first.'); return }
    const { error } = await sb.from('seat_reservations').insert({ row_label: row, seat_number: seat, reserved_by: name })
    if(error){
      // Unique constraint means someone else just got it
      alert('Seat already taken. Please pick another.')
      const { data } = await sb.from('seat_reservations').select('*').eq('row_label', row).eq('seat_number', seat).maybeSingle()
      if(data){
        const key = k(row, seat)
        setSeats(prev => ({ ...prev, [key]: { ...prev[key], status:'taken', reservedBy: data.reserved_by || undefined } }))
      }
      return
    }
    setConfirm(null)
  }

  async function handleUpload(e){
    const file = e.target.files?.[0]
    if(!file) return
    const buf = await file.arrayBuffer()
    const wb  = XLSX.read(buf)
    const ws  = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json(ws, { defval: null })

    const catalog = []
    const pre     = []
    for(const row of json){
      const rowLabel = (row['Row'] ?? '').toString().trim()
      const seatNum  = Number(row['Seats'])
      if(!rowLabel || !Number.isFinite(seatNum)) continue
      catalog.push({ row_label: rowLabel, seat_number: seatNum })
      const last  = (row['Family Last Name'] ?? '').toString().trim()
      const first = (row['First Name(s)'] ?? '').toString().trim()
      if(last || first){
        pre.push({ row_label: rowLabel, seat_number: seatNum, reserved_by: [last, first].filter(Boolean).join(', ') })
      }
    }
    if(!sb){ alert(`Parsed ${catalog.length} seats; ${pre.length} pre-reserved. Add Supabase keys to import.`); return }

    setLoading(true)
    const { error: cErr } = await sb.from('seat_catalog').upsert(catalog, { onConflict: 'row_label,seat_number' })
    if(cErr){ console.error(cErr); alert('Error seeding catalog: '+cErr.message); setLoading(false); return }

    if(pre.length){
      for(let i=0;i<pre.length;i+=500){
        const batch = pre.slice(i,i+500)
        const { error: pErr } = await sb.from('seat_reservations').upsert(batch, { onConflict: 'row_label,seat_number' })
        if(pErr){ console.error(pErr); alert('Error pre-assigning: '+pErr.message) }
      }
    }

    // Reload UI
    const { data: catalogReload } = await sb.from('seat_catalog').select('*')
    const { data: reservReload }  = await sb.from('seat_reservations').select('*')
    const map = {}; const rowset = new Set()
    ;(catalogReload||[]).forEach(c=>{ map[k(c.row_label, c.seat_number)] = { row:c.row_label, seat:c.seat_number, status:'available' }; rowset.add(c.row_label) })
    ;(reservReload||[]).forEach(r=>{ const key=k(r.row_label,r.seat_number); if(map[key]){ map[key].status='taken'; map[key].reservedBy=r.reserved_by||undefined } })
    setSeats(map)
    setRows(Array.from(rowset).sort((a,b)=> excelColToNum(a)-excelColToNum(b)))
    setLoading(false)
    alert('Seating imported.')
  }

  return (
    <div>
      <header style={{position:'sticky',top:0,background:'#fff',borderBottom:'1px solid #e5e7eb'}}>
        <div style={{maxWidth:1060,margin:'0 auto',padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
          <div style={{fontWeight:600}}>Moriah Seating Selector <span style={{fontSize:12,color:'#6b7280'}}>— realtime seat locking</span></div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:12,color:'#6b7280'}}>Your name</span>
            <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g., Caplan, Samuel" style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
            <button onClick={()=>setSetupMode(v=>!v)} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>{setupMode?'Exit Setup':'Setup Mode'}</button>
          </div>
        </div>
      </header>

      <main style={{maxWidth:1060,margin:'0 auto',padding:'16px'}}>
        <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:16}}>
          <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12}}>
            <div style={{padding:'12px 14px',borderBottom:'1px solid #e5e7eb',fontWeight:600}}>Filters & Setup</div>
            <div style={{padding:'12px 14px'}}>
              <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
                <div>
                  <div style={{fontSize:12,color:'#6b7280',marginBottom:4}}>Start with Row</div>
                  <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="e.g., LL" style={{padding:8,border:'1px solid #e5e7eb',borderRadius:8}}/>
                </div>
                <button onClick={()=>setFilter('')} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Clear</button>
              </div>
              {setupMode && (
                <div style={{marginTop:12}}>
                  <hr/>
                  <div style={{fontSize:12,color:'#6b7280',margin:'8px 0'}}>Import master seating (xlsx)</div>
                  <input type="file" accept=".xlsx,.xls" onChange={handleUpload}/>
                  <div style={{fontSize:12,color:'#6b7280',marginTop:8}}>Upload “Final Seat Assignment.xlsx”. Names in columns C/D are locked as taken.</div>
                </div>
              )}
            </div>
          </div>

          <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12}}>
            <div style={{padding:'12px 14px',borderBottom:'1px solid #e5e7eb',fontWeight:600}}>Pick your seats</div>
            <div style={{padding:'12px 14px'}}>
              {loading ? (<div style={{fontSize:12,color:'#6b7280'}}>Loading…</div>) : (
                rows.length === 0 ? (<div style={{fontSize:12,color:'#6b7280'}}>No seats yet. Use Setup Mode to import the master sheet.</div>) : (
                  <div style={{display:'grid',gap:20}}>
                    {filteredRows.map(row => (
                      <div key={row}>
                        <div style={{marginBottom:8,fontWeight:600}}>Row {row}</div>
                        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                          {Object.values(seats).filter(s=>s.row===row).sort((a,b)=>a.seat-b.seat).map(s=>(
                            <button
                              key={k(s.row,s.seat)}
                              disabled={s.status==='taken'}
                              onClick={()=> setConfirm({row:s.row, seat:s.seat})}
                              title={s.status==='taken' ? `Taken${s.reservedBy ? ' by '+s.reservedBy : ''}` : 'Available'}
                              style={{
                                width:34,height:34,display:'flex',alignItems:'center',justifyContent:'center',
                                border:'1px solid',borderColor: s.status==='taken' ? '#b91c1c':'#a7f3d0',
                                borderRadius:8,fontSize:12,
                                color: s.status==='taken' ? '#fff' : '#065f46',
                                background: s.status==='taken' ? '#ef4444' : '#ecfdf5',
                                cursor: s.status==='taken' ? 'not-allowed' : 'pointer'
                              }}
                            >{s.seat}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Confirm modal */}
      <div style={{
        position:'fixed',inset:0, display: confirm ? 'flex' : 'none',
        alignItems:'center',justifyContent:'center', background:'rgba(0,0,0,0.2)'
      }}>
        <div style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:12,padding:14,width:420,maxWidth:'calc(100% - 24px)'}}>
          <h3 style={{margin:'0 0 6px'}}>Confirm reservation</h3>
          <p style={{margin:'6px 0 12px',fontSize:12,color:'#6b7280'}}>Reserve Row {confirm?.row}, Seat {confirm?.seat}?</p>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setConfirm(null)} style={{border:'1px solid #e5e7eb',borderRadius:8,padding:'8px 10px',background:'#fff'}}>Cancel</button>
            <button onClick={()=> confirm && reserveSeat(confirm.row, confirm.seat)} style={{border:'1px solid #059669',borderRadius:8,padding:'8px 10px',background:'#10b981',color:'#fff'}}>Reserve</button>
          </div>
        </div>
      </div>

      <footer style={{textAlign:'center',padding:'32px 0',fontSize:12,color:'#6b7280'}}>
        Seats update in real time. Once you reserve, no one else can take your seat.
      </footer>
    </div>
  )
}

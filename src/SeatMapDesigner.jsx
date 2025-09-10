// src/SeatMapDesigner.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// ---------- Supabase client ----------
const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY
const sb = (supabaseUrl && supabaseAnon) ? createClient(supabaseUrl, supabaseAnon) : null

// ---------- Helpers ----------
const keyOf = (row, seat) => `${row}#${seat}`
const excelColToNum = col => String(col || '').toUpperCase()
  .split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0)

function linspace(n, minX, maxX) {
  if (n <= 1) return [Math.round((minX + maxX) / 2)]
  const step = (maxX - minX) / (n - 1)
  return Array.from({ length: n }, (_, i) => Math.round(minX + i * step))
}
function splitSeats(nums) {
  const sorted = [...nums].sort((a, b) => a - b)
  const leftCount = Math.ceil(sorted.length / 2)
  return [sorted.slice(0, leftCount), sorted.slice(leftCount)]
}

// ---------- Layout profile (for your 1280×720 image) ----------
const SEAT_SIZE = 20
const ROW_PAD   = 18
const COL_PAD   = 18

// Row groups as shown on your diagram
const GROUPS = {
  // small alcoves
  alcoveLeftRows:  ['A','B','C','D','E'],
  alcoveRightRows: ['L','M','N','O','P'],

  // front wide blocks
  frontLeftRows:   ['A','B','C','D','E','F','G'],
  frontRightRows:  ['I','J','K','L','M','N','O','P'],

  // mid bands
  narrowRows:      ['R','S','T','U'],
  midRows:         ['V','W','X','Y','Z','AA','BB'],

  // main floor
  mainRows:        ['CC','DD','EE','FF','GG','HH','II','JJ','KK','LL','MM','NN'],
}

// Panel bounding boxes (x,y,w,h). Adjust if you want finer alignment.
const PANELS = {
  // TOP band (right side + upper middle)
  alcoveRight: { x:  30, y:  28, w: 180, h: 240 },  // L–P small tilted
  frontRight:  { x: 230, y:  12, w: 340, h: 302 },  // I–P wide
  narrowTop:   { x: 590, y:  16, w: 130, h: 300 },  // R–U right half
  midTop:      { x: 748, y:  16, w: 230, h: 300 },  // V–BB right half
  mainRight:   { x:1000, y:  16, w: 250, h: 300 },  // CC–NN right half

  // BOTTOM band (left side + lower middle)
  alcoveLeft:  { x:  30, y: 396, w: 180, h: 260 },  // A–E small tilted
  frontLeft:   { x: 230, y: 352, w: 340, h: 312 },  // A–G wide
  narrowBot:   { x: 590, y: 352, w: 130, h: 312 },  // R–U left half
  midBot:      { x: 748, y: 352, w: 230, h: 312 },  // V–BB left half
  mainLeft:    { x:1000, y: 352, w: 250, h: 312 },  // CC–NN left half
}

// ---------- Component ----------
export default function SeatMapDesigner() {
  const [loading, setLoading] = useState(true)

  // catalog → all rows & seats from DB
  const [rows, setRows] = useState([])
  const [seats, setSeats] = useState([]) // [{row, seat}]

  // coordinates map → { "ROW#SEAT": {x,y} }
  const [coords, setCoords] = useState({})

  // background image + canvas size
  const [imgUrl, setImgUrl] = useState('')
  const [canvasSize, setCanvasSize] = useState({ w: 1280, h: 720 })

  // selection to place pins
  const [selRow, setSelRow] = useState('')
  const [selSeat, setSelSeat] = useState('')
  const [autoInc, setAutoInc] = useState(true)

  // dragging state
  const planeRef = useRef(null)
  const dragRef = useRef({ key: null, dx: 0, dy: 0 })

  // ---- initial load
  useEffect(() => {
    (async () => {
      if (!sb) { setLoading(false); return }
      // load catalog
      const { data: catalog, error: cErr } = await sb.from('seat_catalog').select('*')
      if (cErr) { console.error(cErr); setLoading(false); return }
      const rowSet = new Set()
      const seatList = []
      ;(catalog || []).forEach(c => { rowSet.add(c.row_label); seatList.push({ row: c.row_label, seat: c.seat_number }) })
      const sortedRows = Array.from(rowSet).sort((a, b) => excelColToNum(a) - excelColToNum(b))
      setRows(sortedRows)
      setSeats(seatList)

      // load coords
      const { data: cs } = await sb.from('seat_coords').select('*')
      const map = {}
      ;(cs || []).forEach(c => { map[keyOf(c.row_label, c.seat_number)] = { x: c.x, y: c.y } })
      setCoords(map)

      // load settings
      const { data: settings } = await sb.from('app_settings').select('*')
      const sMap = new Map((settings || []).map(r => [r.key, r.value]))
      if (sMap.get('map_image_url')) setImgUrl(sMap.get('map_image_url'))
      const w = Number(sMap.get('map_canvas_w') || '1280')
      const h = Number(sMap.get('map_canvas_h') || '720')
      setCanvasSize({ w, h })

      setLoading(false)
    })()
  }, [])

  // ---- computed
  const placedCount = useMemo(() => Object.keys(coords).length, [coords])
  const totalSeats  = useMemo(() => seats.length, [seats])

  // ---- actions
  async function saveSettings() {
  if (!sb) return alert('Add Supabase keys')
  const keys   = ['map_image_url','map_canvas_w','map_canvas_h']
  const values = [imgUrl, String(canvasSize.w), String(canvasSize.h)]
  const { error } = await sb.rpc('app_settings_upsert_many', { _keys: keys, _values: values })
  if (error) return alert('Settings save failed: ' + error.message)
  alert('Saved map settings.')
}

  function onPlaneClick(e) {
    if (!selRow || !selSeat) return alert('Choose Row + Seat first')
    const rect = planeRef.current.getBoundingClientRect()
    const x = Math.round(e.clientX - rect.left)
    const y = Math.round(e.clientY - rect.top)
    const k = keyOf(selRow, Number(selSeat))
    setCoords(prev => ({ ...prev, [k]: { x, y } }))
    if (autoInc) setSelSeat(s => (Number(s || 0) + 1))
  }

  function onMouseDown(e, key) {
    e.preventDefault()
    const rect = planeRef.current.getBoundingClientRect()
    dragRef.current = {
      key,
      dx: coords[key].x - (e.clientX - rect.left),
      dy: coords[key].y - (e.clientY - rect.top)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
  function onMouseMove(e) {
    const { key, dx, dy } = dragRef.current
    if (!key) return
    const rect = planeRef.current.getBoundingClientRect()
    const x = Math.round((e.clientX - rect.left) + dx)
    const y = Math.round((e.clientY - rect.top) + dy)
    setCoords(prev => ({ ...prev, [key]: { x, y } }))
  }
  function onMouseUp() {
    dragRef.current = { key: null, dx: 0, dy: 0 }
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  async function saveAll() {
    if (!sb) return alert('Add Supabase keys first.')
    const rows = Object.entries(coords).map(([k, v]) => {
      const [row, seat] = k.split('#')
      return { row_label: row, seat_number: Number(seat), x: v.x, y: v.y }
    })
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await sb.from('seat_coords').upsert(batch, { onConflict: 'row_label,seat_number' })
      if (error) return alert('Save error: ' + error.message)
    }
    alert('All coordinates saved.')
  }

  function exportCSV() {
    const out = [['Row', 'Seat', 'X', 'Y']]
    for (const [k, v] of Object.entries(coords)) {
      const [row, seat] = k.split('#')
      out.push([row, seat, v.x, v.y])
    }
    const csv = out.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'seat_coordinates.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  function importCSV(e) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      const lines = text.split(/\r?\n/).filter(Boolean)
      const head = lines.shift().split(',').map(s => s.trim())
      const idx = { Row: head.indexOf('Row'), Seat: head.indexOf('Seat'), X: head.indexOf('X'), Y: head.indexOf('Y') }
      const map = {}
      for (const line of lines) {
        const cols = line.split(',')
        const row = cols[idx.Row]; const seat = Number(cols[idx.Seat])
        const x = Number(cols[idx.X]); const y = Number(cols[idx.Y])
        if (row && Number.isFinite(seat) && Number.isFinite(x) && Number.isFinite(y)) {
          map[keyOf(row, seat)] = { x, y }
        }
      }
      setCoords(map)
    }
    reader.readAsText(file)
  }

  function removeCurrent() {
    if (!selRow || !selSeat) return
    const k = keyOf(selRow, Number(selSeat))
    setCoords(prev => { const p = { ...prev }; delete p[k]; return p })
  }

  // ---------- Auto-layout (panel-aware) ----------
  function orderRows(list, want) { return list.filter(r => want.includes(r)) }

  async function autoLayout({ onlyRow = null } = {}) {
    const byRow = new Map()
    for (const s of seats) {
      if (onlyRow && s.row !== onlyRow) continue
      if (!byRow.has(s.row)) byRow.set(s.row, [])
      byRow.get(s.row).push(s.seat)
    }
    for (const arr of byRow.values()) arr.sort((a, b) => a - b)

    const assign = {}
    const ensure = (panel, row) => {
      if (!assign[panel]) assign[panel] = {}
      if (!assign[panel][row]) assign[panel][row] = []
    }

    for (const [row, nums] of byRow.entries()) {
      const inList = (A) => A.includes(row)

      if (inList(GROUPS.alcoveLeftRows)) {
        const alc = nums.filter(n => n <= 5)
        const rest = nums.filter(n => n > 5)
        if (alc.length)  { ensure('alcoveLeft', row); assign.alcoveLeft[row].push(...alc) }
        if (rest.length) { ensure('frontLeft',  row); assign.frontLeft[row].push(...rest) }
        continue
      }
      if (inList(GROUPS.alcoveRightRows)) {
        const alc = nums.filter(n => n <= 5)
        const rest = nums.filter(n => n > 5)
        if (alc.length)  { ensure('alcoveRight', row); assign.alcoveRight[row].push(...alc) }
        if (rest.length) { ensure('frontRight',  row); assign.frontRight[row].push(...rest) }
        continue
      }
      if (inList(GROUPS.frontLeftRows))  { ensure('frontLeft',  row); assign.frontLeft[row].push(...nums);  continue }
      if (inList(GROUPS.frontRightRows)) { ensure('frontRight', row); assign.frontRight[row].push(...nums); continue }

      if (inList(GROUPS.narrowRows)) {
        const [left, right] = splitSeats(nums)
        if (left.length)  { ensure('narrowBot', row); assign.narrowBot[row].push(...left) }
        if (right.length) { ensure('narrowTop', row); assign.narrowTop[row].push(...right) }
        continue
      }
      if (inList(GROUPS.midRows)) {
        const [left, right] = splitSeats(nums)
        if (left.length)  { ensure('midBot', row); assign.midBot[row].push(...left) }
        if (right.length) { ensure('midTop', row); assign.midTop[row].push(...right) }
        continue
      }
      if (inList(GROUPS.mainRows)) {
        const [left, right] = splitSeats(nums)
        if (left.length)  { ensure('mainLeft',  row); assign.mainLeft[row].push(...left) }
        if (right.length) { ensure('mainRight', row); assign.mainRight[row].push(...right) }
        continue
      }

      // unknown rows → frontLeft fallback
      ensure('frontLeft', row); assign.frontLeft[row].push(...nums)
    }

    const next = { ...coords }
    for (const [panel, rowsObj] of Object.entries(assign)) {
      const box = PANELS[panel]; if (!box) continue

      // keep visual order per group
      let pRows = Object.keys(rowsObj)
      if (panel === 'alcoveLeft')  pRows = orderRows(GROUPS.alcoveLeftRows, pRows)
      if (panel === 'alcoveRight') pRows = orderRows(GROUPS.alcoveRightRows, pRows)
      if (panel === 'frontLeft')   pRows = orderRows(GROUPS.frontLeftRows,   pRows)
      if (panel === 'frontRight')  pRows = orderRows(GROUPS.frontRightRows,  pRows)
      if (panel === 'narrowTop' || panel === 'narrowBot') pRows = orderRows(GROUPS.narrowRows, pRows)
      if (panel === 'midTop'    || panel === 'midBot')    pRows = orderRows(GROUPS.midRows,    pRows)
      if (panel === 'mainLeft'  || panel === 'mainRight') pRows = orderRows(GROUPS.mainRows,   pRows)

      const yList = linspace(pRows.length, box.y + ROW_PAD, box.y + box.h - ROW_PAD)

      pRows.forEach((rowLabel, idx) => {
        const y = yList[idx]
        const nums = rowsObj[rowLabel].sort((a, b) => a - b)
        const xList = linspace(nums.length,
          box.x + COL_PAD + SEAT_SIZE / 2,
          box.x + box.w - COL_PAD - SEAT_SIZE / 2
        )
        nums.forEach((seatNum, i) => {
          next[keyOf(rowLabel, seatNum)] = { x: xList[i], y }
        })
      })
    }

    setCoords(next)
  }

  // ---------- UI ----------
  if (loading) return <div className="small">Loading map designer…</div>

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Controls */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Controls</div>
          <div style={{ padding: '10px 12px', display: 'grid', gap: 10 }}>
            <div>
              <div className="small">Map Image URL (public)</div>
              <input
                value={imgUrl}
                onChange={e => setImgUrl(e.target.value)}
                placeholder="https://.../Layout.png"
                style={{ width: '100%', padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}
              />
              <div className="small" style={{ marginTop: 6 }}>Canvas size (px):</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" value={canvasSize.w}
                  onChange={e => setCanvasSize(s => ({ ...s, w: Number(e.target.value) || 1280 }))}
                  style={{ width: 120, padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }} />
                <input type="number" value={canvasSize.h}
                  onChange={e => setCanvasSize(s => ({ ...s, h: Number(e.target.value) || 720 }))}
                  style={{ width: 120, padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }} />
                <button onClick={saveSettings}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                  Save settings
                </button>
              </div>
            </div>

            <div>
              <div className="small">Pick Row & Seat, then click on the map to place. Drag to adjust.</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={selRow} onChange={e => setSelRow(e.target.value)}
                  style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                  <option value="">Row…</option>
                  {rows.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input value={selSeat} onChange={e => setSelSeat(e.target.value)} placeholder="Seat…"
                  style={{ width: 100, padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={autoInc} onChange={e => setAutoInc(e.target.checked)} /> auto-increment
                </label>
                <button onClick={removeCurrent}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                  Remove current
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => autoLayout()}
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                Auto-layout (all rows)
              </button>
              <button onClick={() => selRow ? autoLayout({ onlyRow: selRow }) : alert('Pick a Row first')}
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                Auto-layout (selected row)
              </button>
              <button onClick={saveAll}
                style={{ border: '1px solid #059669', borderRadius: 8, padding: '8px 10px', background: '#10b981', color: '#fff' }}>
                Save coordinates
              </button>
              <button onClick={exportCSV}
                style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
                Export CSV
              </button>
              <label style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', background: '#fff', cursor: 'pointer' }}>
                Import CSV
                <input type="file" accept=".csv" onChange={importCSV} style={{ display: 'none' }} />
              </label>
              <div className="small" style={{ marginLeft: 'auto' }}>Placed: {placedCount}/{totalSeats}</div>
            </div>
          </div>
        </div>

        {/* Legend / tips */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Legend</div>
          <div style={{ padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{
              display: 'inline-flex', width: 34, height: 34, border: '1px solid #a7f3d0',
              background: '#ecfdf5', color: '#065f46', borderRadius: 8, alignItems: 'center', justifyContent: 'center'
            }}>#</span>
            <span className="small">Seat pin (drag to adjust). Zoom your browser for precision.</span>
          </div>
        </div>
      </div>

      {/* Designer Canvas */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>Designer Canvas</div>
        <div
          ref={planeRef}
          onClick={onPlaneClick}
          style={{
            position: 'relative', width: canvasSize.w, height: canvasSize.h,
            margin: 12, border: '1px dashed #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fafafa'
          }}
        >
          {imgUrl && (
            <img
              src={imgUrl}
              alt="layout"
              style={{ position: 'absolute', left: 0, top: 0, width: canvasSize.w, height: canvasSize.h,
                       objectFit: 'contain', pointerEvents: 'none', userSelect: 'none' }}
            />
          )}

          {Object.entries(coords).map(([k, p]) => {
            const [row, seat] = k.split('#')
            const left = Math.max(0, Math.min(canvasSize.w - SEAT_SIZE, p.x - SEAT_SIZE / 2))
            const top  = Math.max(0, Math.min(canvasSize.h - SEAT_SIZE, p.y - SEAT_SIZE / 2))
            return (
              <button
                key={k}
                onMouseDown={(e) => onMouseDown(e, k)}
                title={`Row ${row}, Seat ${seat}`}
                style={{
                  position: 'absolute', left, top, width: SEAT_SIZE, height: SEAT_SIZE,
                  border: '1px solid #a7f3d0', borderRadius: 8, background: '#ecfdf5',
                  color: '#065f46', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'grab'
                }}
              >{seat}</button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

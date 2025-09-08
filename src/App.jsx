// Moriah Seating Selector — Pro Upgrade (All Features)
// -----------------------------------------------------------------------------
// Features added in this version:
// 1) Supabase Auth (invite-only): email sign-in/out gate for reserving.
// 2) Admin panel: search by name, free/clear seat, export CSV, undo last.
// 3) Group booking: pick 2–6 contiguous seats; auto-scan from clicked seat.
// 4) Soft holds: 5-minute hold (configurable) blocks others; realtime yellow state.
// 5) Audit log: who did what, when; exportable.
// 6) Seat map overlay (optional): upload seat_coordinates.csv with x,y per seat
// and toggle "Map Mode" to place clickable pins on the map.
// 7) Real-time updates: reservations + holds are live across all clients.
// 8) Import master sheet like before (Setup Mode).
//
// Requirements
// - Environment vars (Vite):
// VITE_SUPABASE_URL
// VITE_SUPABASE_ANON_KEY
// VITE_ADMIN_EMAILS (comma-separated list; e.g., "you@org.org, other@org.org")
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
}
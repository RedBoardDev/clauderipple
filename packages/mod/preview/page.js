// The preview page: each scene's tree drawn the way the desktop app draws a mod's site, once on
// the dark Code tab and once on the light one. See render.mjs for where the numbers come from.
/* global window, document */
;(function () {
  const CH = 7.917 // 1ch of 13 px anthropic-sans
  const LH = 19
  const THEMES = {
    dark: { page: '#262624', site: 'rgba(255,255,255,0.035)', ink: 'rgb(240,239,236)', dim: 'rgb(137,135,129)', warning: '#e0a83a', error: '#e5534b', success: '#3ecb7d', primary: '#c6613f', ghost: 'rgba(240,239,236,0.09)' },
    light: { page: '#faf9f5', site: 'rgba(0,0,0,0.035)', ink: 'rgb(31,30,29)', dim: 'rgb(115,114,108)', warning: '#a86a07', error: '#c2362f', success: '#1a8a4a', primary: '#c6613f', ghost: 'rgba(31,30,29,0.07)' },
  }
  let uid = 0
  const css = []
  // Hover groups: a `hover.scope` names a group of this page's elements (the app: every element of
  // one plugin's with the same string, in any site, lights while any is hovered). :has() is the one
  // CSS way to say "any member hovered restyles this member"; the preview runs in Chrome.
  const groups = new Map()

  const cells = n => (typeof n === 'number' ? n * CH + 'px' : n)
  const rows = n => (typeof n === 'number' ? n * LH + 'px' : n)
  const half = n => (typeof n === 'number' ? n * LH * 0.5 + 'px' : n)
  const color = (c, t) => (c in t ? t[c] : c)

  function styleBox(p, t) {
    // As in the app (2026-10-13): a Box is absolute when it says so, relative only when one of its
    // own children is absolute (a `relative` it asks for is not taken), else static; an absolute
    // Box paints over every Box that is not positioned, whatever comes after it.
    const absChild = (p.__children || []).some(c => c && c.type === 'Box' && c.props && c.props.position === 'absolute')
    const s = { display: p.display === 'none' ? 'none' : 'flex', flexDirection: p.flexDirection ?? 'row', position: p.position === 'absolute' ? 'absolute' : absChild ? 'relative' : 'static', boxSizing: 'border-box', minWidth: 0 }
    if (p.top !== undefined) s.top = rows(p.top)
    if (p.bottom !== undefined) s.bottom = rows(p.bottom)
    if (p.left !== undefined) s.left = cells(p.left)
    if (p.right !== undefined) s.right = cells(p.right)
    for (const k of ['flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent']) if (p[k] !== undefined) s[k] = p[k]
    if (p.flexShrink === undefined) s.flexShrink = 1
    if (p.width !== undefined) s.width = cells(p.width)
    if (p.minWidth !== undefined) s.minWidth = cells(p.minWidth)
    if (p.height !== undefined) s.height = rows(p.height)
    if (p.minHeight !== undefined) s.minHeight = rows(p.minHeight)
    if (p.gap !== undefined) { s.columnGap = cells(p.gap); s.rowGap = half(p.gap) }
    if (p.columnGap !== undefined) s.columnGap = cells(p.columnGap)
    if (p.rowGap !== undefined) s.rowGap = half(p.rowGap)
    const pad = { t: p.paddingTop ?? p.paddingY ?? p.padding, b: p.paddingBottom ?? p.paddingY ?? p.padding, l: p.paddingLeft ?? p.paddingX ?? p.padding, r: p.paddingRight ?? p.paddingX ?? p.padding }
    const mar = { t: p.marginTop ?? p.marginY ?? p.margin, b: p.marginBottom ?? p.marginY ?? p.margin, l: p.marginLeft ?? p.marginX ?? p.margin, r: p.marginRight ?? p.marginX ?? p.margin }
    if (pad.t !== undefined) s.paddingTop = half(pad.t)
    if (pad.b !== undefined) s.paddingBottom = half(pad.b)
    if (pad.l !== undefined) s.paddingLeft = cells(pad.l)
    if (pad.r !== undefined) s.paddingRight = cells(pad.r)
    if (mar.t !== undefined) s.marginTop = half(mar.t)
    if (mar.b !== undefined) s.marginBottom = half(mar.b)
    if (mar.l !== undefined) s.marginLeft = cells(mar.l)
    if (mar.r !== undefined) s.marginRight = cells(mar.r)
    if (p.borderStyle) {
      s.border = '1px solid ' + (p.borderColor ? color(p.borderColor, t) : t.dim)
      s.borderRadius = '10px'
      if (pad.t === undefined) s.paddingTop = '8px'
      if (pad.b === undefined) s.paddingBottom = '8px'
    }
    if (p.backgroundColor) s.backgroundColor = color(p.backgroundColor, t)
    if (p.overflow === 'hidden') s.overflow = 'hidden'
    // A placed Box is not a hover target of its own: "the pointer on it is on its parent" (the Box
    // position docs), so it lets the pointer through to what lies beneath — a tip layer over the
    // facts must not eat the facts' own hovers. Only what a person acts on (a press, a field) keeps
    // the pointer; everything else placed is paint.
    if (p.position === 'absolute' && !holdsPressable(p.__children)) s.pointerEvents = 'none'
    return s
  }

  /** Whether a subtree holds a native control (a piece the person acts on). */
  function holdsPressable(children) {
    for (const c of children || []) {
      if (!c || typeof c !== 'object') continue
      if (Array.isArray(c)) { if (holdsPressable(c)) return true; continue }
      if (c.type === 'Button' || c.type === 'Input' || c.type === 'Select') return true
      if (holdsPressable(c.children)) return true
    }
    return false
  }

  function apply(el, s) {
    for (const [k, v] of Object.entries(s)) el.style[k] = v
  }

  function hoverRule(scopeId, el, hover, t, prefix) {
    if (!hover) return
    const decl = []
    if (hover.display) decl.push('display:' + hover.display)
    if (hover.color) decl.push('color:' + color(hover.color, t))
    if (hover.backgroundColor) decl.push('background-color:' + color(hover.backgroundColor, t))
    if (hover.borderColor) decl.push('border-color:' + color(hover.borderColor, t))
    if (hover.bold) decl.push('font-weight:580')
    if (hover.underline) decl.push('text-decoration:underline')
    if (hover.dimColor === false) decl.push('color:' + t.ink)
    if (!decl.length && !hover.scope) return
    const decls = decl.map(d => d + ' !important').join(';')
    // A hover with a `scope` applies while any element of its group is hovered (never by the keyed
    // Box above it: that would light every tip as soon as the pointer was anywhere on the band);
    // :has() is the one CSS way to say "any member hovered restyles this member". The group name is
    // per scene, as each scene here is a site of its own and a scope never crosses sites.
    if (hover.scope) {
      const cls = 'g' + prefix + '-' + String(hover.scope).replace(/[^A-Za-z0-9_-]/g, '_')
      el.classList.add(cls)
      if (decl.length) {
        el.id = el.id || 'e' + ++uid
        css.push('html:has(.' + cls + ':hover) #' + el.id + '{' + decls + '}')
      }
      return
    }
    // No scope: the hover applies while the pointer is over the nearest keyed Box around it (the
    // unkeyed hidden layer the close button reveals itself with).
    el.id = el.id || 'e' + ++uid
    if (scopeId) css.push('#' + scopeId + ':hover #' + el.id + (scopeId === el.id ? '' : '') + '{' + decls + '}')
  }

  function text(node, t, scope, inline, prefix) {
    const p = node.hover ? { ...node.props, hover: node.hover } : node.props || {}
    const el = document.createElement('span')
    el.style.display = inline ? 'inline' : 'block'
    el.style.whiteSpace = p.wrap === 'wrap' ? 'pre-wrap' : 'pre'
    if (p.wrap && p.wrap.startsWith('truncate')) { el.style.overflow = 'hidden'; el.style.textOverflow = 'ellipsis'; el.style.minWidth = '0' }
    if (p.color) el.style.color = color(p.color, t)
    if (p.dimColor) el.style.color = t.dim
    if (p.backgroundColor) el.style.backgroundColor = color(p.backgroundColor, t)
    if (p.bold) el.style.fontWeight = '580'
    if (p.italic) el.style.fontStyle = 'italic'
    if (p.underline) el.style.textDecoration = 'underline'
    if (p.strikethrough) el.style.textDecoration = 'line-through'
    for (const c of node.children || []) {
      if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)))
      else if (c && c.type === 'Text') el.appendChild(text(c, t, scope, true, prefix))
    }
    hoverRule(scope, el, p.hover, t, prefix)
    return el
  }

  function button(node, t, scope, prefix) {
    const p = node.hover ? { ...node.props, hover: node.hover } : node.props || {}
    const b = document.createElement('button')
    b.type = 'button'
    b.title = 'key: ' + (p.key ?? p.label)
    const label = p.label ?? (node.children || []).filter(c => typeof c === 'string').join('')
    apply(b, { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center', gap: '6px', font: 'inherit', fontSize: '12px', lineHeight: '17px', whiteSpace: 'nowrap', borderRadius: '5px', border: 'none', cursor: 'default', color: p.dimColor ? t.dim : t.ink, background: 'transparent', padding: '0 6px', maxWidth: '100%' })
    b.id = 'e' + ++uid
    if (!p.plain || p.role === 'dismiss') {
      if (p.role === 'dismiss') apply(b, { fontSize: '15px', padding: '0 6px', color: t.dim })
      else if (p.variant === 'primary') apply(b, { background: t.primary, color: '#fff', padding: '3px 9px', borderRadius: '6px' })
      else apply(b, { border: '1px solid ' + t.ghost, background: t.ghost, padding: '3px 9px', borderRadius: '6px' })
    }
    css.push('#' + b.id + ':hover{background:' + (p.variant === 'primary' && !p.plain ? t.primary : t.ghost) + ' !important;color:' + (p.variant === 'primary' && !p.plain ? '#fff' : t.ink) + ' !important}')
    if (p.hotkey) {
      const k = document.createElement('span')
      k.textContent = p.hotkey
      apply(k, { fontSize: '10px', lineHeight: '10px', border: '1px solid ' + t.dim, borderRadius: '4px', padding: '1px 3px', color: t.dim })
      b.appendChild(k)
    }
    const s = document.createElement('span')
    apply(s, { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    s.textContent = p.role === 'dismiss' ? '×' : label
    b.appendChild(s)
    hoverRule(scope, s, p.hover, t, prefix)
    return b
  }

  function draw(node, t, scope, prefix) {
    if (node === null || node === undefined || node === false || node === true || node === '') return null
    if (typeof node === 'string' || typeof node === 'number') return text({ props: {}, children: [String(node)] }, t, scope, false, prefix)
    if (Array.isArray(node)) {
      const f = document.createDocumentFragment()
      for (const c of node) { const d = draw(c, t, scope, prefix); if (d) f.appendChild(d) }
      return f
    }
    const p = node.hover ? { ...node.props, hover: node.hover } : node.props || {}
    switch (node.type) {
      case 'Box': {
        const el = document.createElement('div')
        apply(el, styleBox({ ...p, __children: (node.children || []).flat(Infinity) }, t))
        let inner = scope
        if (p.key) { el.id = 'e' + ++uid; inner = el.id }
        hoverRule(scope === inner ? scope : inner, el, p.hover, t, prefix)
        for (const c of node.children || []) { const d = draw(c, t, inner, prefix); if (d) el.appendChild(d) }
        return el
      }
      case 'Text':
        return text(node, t, scope, false, prefix)
      case 'Button':
        return button(node, t, scope, prefix)
      case 'Svg': {
        // The app refuses an Svg whose alt is blank once trimmed and draws nothing in its place.
        if (!String(p.alt ?? '').trim()) return document.createComment('Svg refused: blank alt')
        const img = document.createElement('img')
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.source)
        img.alt = p.alt
        apply(img, { display: 'block', flexShrink: 0 })
        if (p.width) img.style.width = p.width + 'px'
        if (p.height) img.style.height = p.height + 'px'
        return img
      }
      case 'Input': {
        const el = document.createElement('div')
        apply(el, { display: 'flex', gap: '8px', alignItems: 'center', border: '1px solid ' + t.ghost, borderRadius: '8px', padding: '4px 8px', flexGrow: 1 })
        if (p.label) { const l = document.createElement('b'); l.textContent = p.label; el.appendChild(l) }
        const i = document.createElement('input')
        i.placeholder = p.placeholder ?? ''
        i.value = p.value ?? ''
        apply(i, { flexGrow: 1, background: 'transparent', border: 'none', color: t.ink, font: 'inherit', outline: 'none' })
        el.appendChild(i)
        if (p.submitLabel) el.appendChild(button({ props: { label: p.submitLabel } }, t, scope, prefix))
        return el
      }
      case 'Select': {
        const s = document.createElement('select')
        for (const o of p.options || []) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; if (o.value === p.value) op.selected = true; s.appendChild(op) }
        apply(s, { font: 'inherit', fontSize: '12px', color: t.ink, background: t.ghost, border: '1px solid ' + t.ghost, borderRadius: '6px', padding: '2px 6px' })
        return s
      }
      case 'Markdown': {
        // Close enough to read a layout by: paragraphs, bullets, **bold** and `code` in the host's ink.
        const el = document.createElement('div')
        apply(el, { color: p.dimColor ? t.dim : t.ink, minWidth: 0, overflowWrap: 'anywhere' })
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b style="font-weight:580">$1</b>').replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,monospace;font-size:12px;padding:0 3px;border-radius:4px;background:' + t.ghost + '">$1</code>')
        el.innerHTML = String(p.text ?? '').split(/\n{2,}/).map(par => {
          const lines = par.split('\n')
          if (lines.every(l => /^\s*[-*] /.test(l))) return '<ul style="margin:0 0 6px;padding-left:18px">' + lines.map(l => '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>').join('') + '</ul>'
          return '<p style="margin:0 0 6px">' + lines.map(inline).join('<br>') + '</p>'
        }).join('')
        return el
      }
      case 'Link': {
        const a = document.createElement('a')
        a.textContent = p.label ?? p.url
        a.style.color = t.ink
        return a
      }
      default: {
        const f = document.createDocumentFragment()
        for (const c of node.children || []) { const d = draw(c, t, scope, prefix); if (d) f.appendChild(d) }
        return f
      }
    }
  }

  document.body.style.margin = '0'
  document.body.style.fontFamily = "anthropic-sans, system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif"
  document.body.style.background = '#111'
  const grid = document.createElement('div')
  apply(grid, { display: 'grid', gridTemplateColumns: '1fr', gap: '0' })
  document.body.appendChild(grid)
  // `#settings,band-menu` draws those scenes alone; `@light` or `@dark` after one picks its theme.
  const wanted = decodeURIComponent(window.location.hash.slice(1)).split(',').filter(Boolean).map(w => w.split('@'))
  for (const scene of window.SCENES) {
    const pick = wanted.find(([name]) => name === scene.name)
    if (wanted.length && !pick) continue
    for (const mode of ['dark', 'light']) {
      if (pick && pick[1] && pick[1] !== mode) continue
      const t = THEMES[mode]
      const frame = document.createElement('section')
      frame.dataset.scene = scene.name + '-' + mode
      apply(frame, { background: t.page, color: t.ink, padding: '14px 18px', colorScheme: mode, fontSize: '13px', lineHeight: '19px' })
      const cap = document.createElement('div')
      cap.textContent = scene.name + ' · ' + mode + ' · ' + scene.columns + ' cols'
      apply(cap, { fontSize: '11px', color: t.dim, marginBottom: '6px', fontFamily: 'ui-monospace, monospace' })
      frame.appendChild(cap)
      const site = document.createElement('div')
      apply(site, { width: scene.columns * CH + 16 + 'px', padding: '8px', borderRadius: '10px', background: t.site, minHeight: '40px', boxSizing: 'border-box' })
      // Scenes are separate sites, and a hover scope never crosses plugins (nor scenes here).
      const prefix = scene.name.replace(/[^A-Za-z0-9]/g, '_')
      const d = draw(scene.tree, t, null, prefix)
      if (d) site.appendChild(d)
      frame.appendChild(site)
      grid.appendChild(frame)
    }
  }
  const style = document.createElement('style')
  style.textContent = css.join('\n') + '\nbutton:focus{outline:none}'
  document.head.appendChild(style)
})()

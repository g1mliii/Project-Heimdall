/* @ds-bundle: {"format":3,"namespace":"HeimdallDesignSystem_da7d5f","components":[{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Stat","sourcePath":"components/core/Stat.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Diagnostic","sourcePath":"components/feedback/Diagnostic.jsx"},{"name":"Meter","sourcePath":"components/feedback/Meter.jsx"},{"name":"Spinner","sourcePath":"components/feedback/Spinner.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Segmented","sourcePath":"components/forms/Segmented.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"}],"sourceHashes":{"components/core/Avatar.jsx":"5d254ff3dc85","components/core/Badge.jsx":"2085590716b2","components/core/Button.jsx":"61daf78ca2ff","components/core/Card.jsx":"40a4c0907a72","components/core/IconButton.jsx":"19632bd2513b","components/core/Stat.jsx":"a25d3dce2df8","components/core/Tag.jsx":"d424813f2ee4","components/feedback/Diagnostic.jsx":"4f371d3b297e","components/feedback/Meter.jsx":"70ba850e2b64","components/feedback/Spinner.jsx":"31841f0e6f4f","components/feedback/Tooltip.jsx":"6f5fdc9a8207","components/forms/Checkbox.jsx":"2da817a2c0e7","components/forms/Input.jsx":"c81547c04cef","components/forms/Segmented.jsx":"fe0f83d13248","components/forms/Select.jsx":"b9db2bfbba79","components/forms/Switch.jsx":"228cfb8fc0ac","components/navigation/Tabs.jsx":"82b2162fb2f1","ui_kits/desktop/CaptureClient.jsx":"3a027cef98f6","ui_kits/web/AppShell.jsx":"62dcdc36aa07","ui_kits/web/GamePage.jsx":"9cbc871b134d","ui_kits/web/RunPage.jsx":"23eafd6a19fb","ui_kits/web/charts.jsx":"bbab0afd4d6e","ui_kits/web/extras.jsx":"f14f67324c9e","ui_kits/web/screens.jsx":"effbd7a913b5","ui_kits/web/tweaks-panel.jsx":"6591467622ed"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.HeimdallDesignSystem_da7d5f = window.HeimdallDesignSystem_da7d5f || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** User avatar — image when `src` is set, otherwise initials. */
function Avatar({
  src,
  name = '',
  size = 'md',
  className = '',
  ...rest
}) {
  const initials = name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const cls = ['hd-avatar', size !== 'md' ? `hd-avatar--${size}` : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name
  }) : initials || '?');
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Small status label. Use semantic tones to carry meaning, not decoration. */
function Badge({
  tone = 'neutral',
  dot = false,
  className = '',
  children,
  ...rest
}) {
  const cls = ['hd-badge', `hd-badge--${tone}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    className: "hd-badge__dot",
    "aria-hidden": "true"
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Heimdall primary action button. Thin wrapper over the .hd-btn classes.
 */
function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const cls = ['hd-btn', `hd-btn--${variant}`, size !== 'md' ? `hd-btn--${size}` : '', block ? 'hd-btn--block' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: cls,
    disabled: disabled || loading
  }, rest), loading ? /*#__PURE__*/React.createElement("span", {
    className: "hd-spinner",
    "aria-hidden": "true"
  }) : iconLeft, children != null && /*#__PURE__*/React.createElement("span", null, children), !loading && iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Surface container. Compose with Card.Header / Card.Body or pass children directly. */
function Card({
  variant,
  interactive = false,
  className = '',
  children,
  ...rest
}) {
  const cls = ['hd-card', variant ? `hd-card--${variant}` : '', interactive ? 'hd-card--interactive' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), children);
}
Card.Header = function CardHeader({
  title,
  actions,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-card__head', className].filter(Boolean).join(' ')
  }, rest), title ? /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, title) : children, actions);
};
Card.Body = function CardBody({
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-card__body', className].filter(Boolean).join(' ')
  }, rest), children);
};
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Square icon-only button. Always pass an accessible `aria-label`. */
function IconButton({
  size = 'md',
  solid = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  const cls = ['hd-iconbtn', size !== 'md' ? `hd-iconbtn--${size}` : '', solid ? 'hd-iconbtn--solid' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls,
    disabled: disabled
  }, rest), children);
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Stat.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Big-number metric tile. The numeric value always renders in the mono face. */
function Stat({
  label,
  value,
  unit,
  delta,
  deltaDir,
  accent,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-stat', className].filter(Boolean).join(' ')
  }, rest), accent && /*#__PURE__*/React.createElement("div", {
    className: "hd-stat__accent",
    style: {
      background: accent
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__value"
  }, value, unit && /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__unit"
  }, unit)), delta != null && /*#__PURE__*/React.createElement("span", {
    className: `hd-stat__delta hd-stat__delta--${deltaDir === 'down' ? 'down' : 'up'}`
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.4",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, deltaDir === 'down' ? /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6"
  }) : /*#__PURE__*/React.createElement("path", {
    d: "m6 15 6-6 6 6"
  })), delta));
}
Object.assign(__ds_scope, { Stat });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Stat.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Dismissible chip — filters, selected hardware, applied settings. */
function Tag({
  onRemove,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['hd-tag', className].filter(Boolean).join(' ')
  }, rest), children, onRemove && /*#__PURE__*/React.createElement("span", {
    className: "hd-tag__close",
    role: "button",
    tabIndex: 0,
    "aria-label": "Remove",
    onClick: onRemove,
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') onRemove(e);
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  }))));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Diagnostic.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const ICONS = {
  warn: /*#__PURE__*/React.createElement("path", {
    d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"
  }),
  bad: /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m15 9-6 6m0-6 6 6"
  })),
  good: /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m9 12 2 2 4-4"
  })),
  info: /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 16v-4m0-4h.01"
  }))
};

/**
 * Diagnostic callout — the core of Heimdall's auto-advice (VRAM saturation,
 * CPU bottleneck, RAM below rated, driver outdated, etc.).
 */
function Diagnostic({
  severity = 'info',
  title,
  children,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-diag', `hd-diag--${severity}`, className].filter(Boolean).join(' '),
    role: "status"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, ICONS[severity] || ICONS.info)), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, title && /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, title), children && /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, children)));
}
Object.assign(__ds_scope, { Diagnostic });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Diagnostic.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Meter.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Labeled progress / utilization meter (VRAM, GPU load, percentile fill). */
function Meter({
  label,
  value = 0,
  max = 100,
  display,
  color = 'var(--brand-teal)',
  className = '',
  ...rest
}) {
  const pct = Math.max(0, Math.min(100, value / max * 100));
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-meter', className].filter(Boolean).join(' ')
  }, rest), (label || display) && /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__head"
  }, label && /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label"
  }, label), display && /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__value"
  }, display)), /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__track",
    role: "progressbar",
    "aria-valuenow": value,
    "aria-valuemax": max
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__fill",
    style: {
      width: `${pct}%`,
      background: color
    }
  })));
}
Object.assign(__ds_scope, { Meter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Meter.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Spinner.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Indeterminate loading spinner. */
function Spinner({
  size = 18,
  label,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--space-2)'
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: ['hd-spinner', className].filter(Boolean).join(' '),
    style: {
      width: size,
      height: size
    },
    role: "status",
    "aria-label": label || 'Loading'
  }), label && /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-3)'
    }
  }, label));
}
Object.assign(__ds_scope, { Spinner });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Spinner.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Hover/focus tooltip. Wraps its trigger children. */
function Tooltip({
  content,
  className = '',
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['hd-tooltip', className].filter(Boolean).join(' '),
    tabIndex: 0
  }, rest), children, /*#__PURE__*/React.createElement("span", {
    className: "hd-tooltip__pop",
    role: "tooltip"
  }, content));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Checkbox with inline label. */
function Checkbox({
  checked,
  onChange,
  label,
  id,
  disabled = false,
  className = '',
  ...rest
}) {
  const cbId = id || `hd-${Math.random().toString(36).slice(2, 8)}`;
  return /*#__PURE__*/React.createElement("label", {
    className: ['hd-check', className].filter(Boolean).join(' '),
    htmlFor: cbId
  }, /*#__PURE__*/React.createElement("input", _extends({
    id: cbId,
    type: "checkbox",
    checked: checked,
    onChange: onChange,
    disabled: disabled
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "hd-check__box",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "3",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  }))), label && /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Text input with optional label, hint/error, and leading icon. */
function Input({
  label,
  hint,
  error,
  icon,
  mono = false,
  id,
  className = '',
  wrapClassName = '',
  ...rest
}) {
  const inputId = id || (label ? `hd-${Math.random().toString(36).slice(2, 8)}` : undefined);
  const input = /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    className: ['hd-input', mono ? 'hd-input--mono' : '', error ? 'hd-input--error' : '', className].filter(Boolean).join(' '),
    "aria-invalid": error ? true : undefined
  }, rest));
  return /*#__PURE__*/React.createElement("div", {
    className: ['hd-field', wrapClassName].filter(Boolean).join(' ')
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "hd-field__label",
    htmlFor: inputId
  }, label), icon ? /*#__PURE__*/React.createElement("span", {
    className: "hd-input__wrap"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-input__icon"
  }, icon), input) : input, (error || hint) && /*#__PURE__*/React.createElement("span", {
    className: `hd-field__hint${error ? ' hd-field__hint--error' : ''}`
  }, error || hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Segmented.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Segmented control — 2–4 mutually exclusive options. Controlled via `value`. */
function Segmented({
  options = [],
  value,
  onChange,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-segmented', className].filter(Boolean).join(' '),
    role: "group"
  }, rest), options.map(o => {
    const v = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    const icon = typeof o === 'string' ? null : o.icon;
    return /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      className: "hd-segmented__opt",
      "aria-pressed": value === v,
      onClick: () => onChange && onChange(v)
    }, icon, label);
  }));
}
Object.assign(__ds_scope, { Segmented });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Segmented.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Native select with the Heimdall chevron + surface styling. */
function Select({
  label,
  hint,
  options = [],
  id,
  className = '',
  children,
  ...rest
}) {
  const selId = id || (label ? `hd-${Math.random().toString(36).slice(2, 8)}` : undefined);
  return /*#__PURE__*/React.createElement("div", {
    className: ['hd-field', className].filter(Boolean).join(' ')
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "hd-field__label",
    htmlFor: selId
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "hd-select"
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: selId
  }, rest), children || options.map(o => {
    const value = typeof o === 'string' ? o : o.value;
    const text = typeof o === 'string' ? o : o.label;
    return /*#__PURE__*/React.createElement("option", {
      key: value,
      value: value
    }, text);
  })), /*#__PURE__*/React.createElement("span", {
    className: "hd-select__chev",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m6 9 6 6 6-6"
  })))), hint && /*#__PURE__*/React.createElement("span", {
    className: "hd-field__hint"
  }, hint));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Toggle switch. Controlled via `checked` + `onChange`. */
function Switch({
  checked,
  onChange,
  label,
  id,
  disabled = false,
  className = '',
  ...rest
}) {
  const swId = id || `hd-${Math.random().toString(36).slice(2, 8)}`;
  return /*#__PURE__*/React.createElement("label", {
    className: ['hd-switch', className].filter(Boolean).join(' '),
    htmlFor: swId
  }, /*#__PURE__*/React.createElement("input", _extends({
    id: swId,
    type: "checkbox",
    role: "switch",
    checked: checked,
    onChange: onChange,
    disabled: disabled
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__thumb"
  })), label && /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__label"
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Underlined tab bar. Controlled via `value` + `onChange`. */
function Tabs({
  tabs = [],
  value,
  onChange,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['hd-tabs', className].filter(Boolean).join(' '),
    role: "tablist"
  }, rest), tabs.map(t => {
    const v = typeof t === 'string' ? t : t.value;
    const label = typeof t === 'string' ? t : t.label;
    const icon = typeof t === 'string' ? null : t.icon;
    const active = value === v;
    return /*#__PURE__*/React.createElement("button", {
      key: v,
      type: "button",
      role: "tab",
      "aria-selected": active,
      className: `hd-tab${active ? ' hd-tab--active' : ''}`,
      onClick: () => onChange && onChange(v)
    }, icon, label);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/desktop/CaptureClient.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Heimdall Desktop — Tauri 2 capture client. States: ready → capturing → complete.
const DIcon = ({
  n,
  size,
  style,
  ...p
}) => /*#__PURE__*/React.createElement("i", _extends({
  "data-lucide": n,
  style: {
    width: size || 18,
    height: size || 18,
    ...style
  }
}, p));
function HwRow({
  k,
  v
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '7px 0',
      borderBottom: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-3)'
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-1)'
    }
  }, v));
}
function CaptureClient() {
  const [state, setState] = React.useState('onboarding'); // onboarding | ready | capturing | complete
  const [sec, setSec] = React.useState(0);
  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
  React.useEffect(() => {
    if (state !== 'capturing') return;
    setSec(0);
    const id = setInterval(() => setSec(s => {
      if (s >= 60) {
        clearInterval(id);
        setState('complete');
        return 60;
      }
      return s + 1;
    }), 45); // sped up for the demo
    return () => clearInterval(id);
  }, [state]);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return /*#__PURE__*/React.createElement("div", {
    className: "win"
  }, /*#__PURE__*/React.createElement("div", {
    className: "titlebar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "name"
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-mark.svg",
    width: "16",
    height: "16",
    alt: ""
  }), " Heimdall Capture"), /*#__PURE__*/React.createElement("span", {
    className: "winctl"
  }, /*#__PURE__*/React.createElement("button", {
    "aria-label": "Minimize"
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "minus",
    size: 14
  })), /*#__PURE__*/React.createElement("button", {
    "aria-label": "Maximize"
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "square",
    size: 12
  })), /*#__PURE__*/React.createElement("button", {
    className: "close",
    "aria-label": "Close"
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "x",
    size: 14
  })))), /*#__PURE__*/React.createElement("div", {
    className: "body"
  }, state === 'onboarding' && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      height: 44,
      borderRadius: 'var(--radius-md)',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--brand-teal-dim)',
      color: 'var(--brand-teal)'
    }
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "shield-check",
    size: 22
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "One-time setup"), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 2
    }
  }, "No administrator rights required"))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)',
      marginBottom: 14
    }
  }, "Heimdall captures with Intel PresentMon 2.3.1+, which runs without admin once your account is in the ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: 'var(--fg-1)'
    }
  }, "Performance Log Users"), " group."), /*#__PURE__*/React.createElement("div", {
    className: "hd-card hd-card--inset",
    style: {
      padding: 14,
      marginBottom: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, [['1', 'Add this account to Performance Log Users', 'done'], ['2', 'Sign out and back in to apply', 'done'], ['3', 'Bundled PresentMon CLI detected', 'done']].map(([n, label, st]) => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      flex: 'none',
      display: 'grid',
      placeItems: 'center',
      color: 'var(--good)'
    }
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "check",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-1)'
    }
  }, label)))), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary hd-btn--block",
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "external-link",
    size: 15
  }), " Open setup guide"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary hd-btn--block hd-btn--lg",
    onClick: () => setState('ready')
  }, "Continue ", /*#__PURE__*/React.createElement(DIcon, {
    n: "arrow-right",
    size: 16
  }))), state !== 'onboarding' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 44,
      height: 44,
      borderRadius: 'var(--radius-md)',
      display: 'grid',
      placeItems: 'center',
      background: state === 'capturing' ? 'var(--bad-dim)' : state === 'complete' ? 'var(--good-dim)' : 'var(--brand-teal-dim)',
      color: state === 'capturing' ? 'var(--bad)' : state === 'complete' ? 'var(--good)' : 'var(--brand-teal)'
    }
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: state === 'capturing' ? 'radio' : state === 'complete' ? 'check' : 'activity',
    size: 22
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, state === 'ready' && 'Ready to capture', state === 'capturing' && 'Capturing…', state === 'complete' && 'Capture complete'), /*#__PURE__*/React.createElement("div", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: `hd-badge hd-badge--${state === 'capturing' ? 'bad' : state === 'complete' ? 'good' : 'neutral'}`,
    style: {
      height: 18
    }
  }, state !== 'complete' && /*#__PURE__*/React.createElement("span", {
    className: "hd-badge__dot"
  }), "PresentMon \xB7 Windows")))), state === 'capturing' && /*#__PURE__*/React.createElement("div", {
    className: "hd-card hd-card--inset",
    style: {
      padding: 14,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Elapsed"), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-metric)',
      color: 'var(--fg-1)'
    }
  }, mm, ":", ss)), /*#__PURE__*/React.createElement(FrameTimeChart, {
    seed: 12,
    height: 86
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--tier-avg)'
    }
  }, "142 fps"), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-3)'
    }
  }, Math.round(sec / 60 * 14900).toLocaleString(), " frames"))), state === 'complete' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 8,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-stat",
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-stat__accent",
    style: {
      background: 'var(--tier-avg)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__label"
  }, "Avg"), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__value",
    style: {
      fontSize: 'var(--text-xl)'
    }
  }, "144")), /*#__PURE__*/React.createElement("div", {
    className: "hd-stat",
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-stat__accent",
    style: {
      background: 'var(--tier-p1)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__label"
  }, "1% Low"), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__value",
    style: {
      fontSize: 'var(--text-xl)'
    }
  }, "98")), /*#__PURE__*/React.createElement("div", {
    className: "hd-stat",
    style: {
      padding: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-stat__accent",
    style: {
      background: 'var(--tier-p01)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__label"
  }, "0.1%"), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__value",
    style: {
      fontSize: 'var(--text-xl)'
    }
  }, "71"))), state !== 'capturing' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: 6
    }
  }, "Detected hardware"), /*#__PURE__*/React.createElement(HwRow, {
    k: "Game",
    v: "Cyberpunk 2077"
  }), /*#__PURE__*/React.createElement(HwRow, {
    k: "GPU",
    v: "RTX 4070"
  }), /*#__PURE__*/React.createElement(HwRow, {
    k: "CPU",
    v: "Ryzen 7 7800X3D"
  }), /*#__PURE__*/React.createElement(HwRow, {
    k: "Driver",
    v: "566.14"
  }), /*#__PURE__*/React.createElement(HwRow, {
    k: "Capture",
    v: "Shift + F11"
  })), state === 'ready' && /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--warn",
    style: {
      padding: '10px 12px',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "shield-alert",
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "Anti-cheat detected"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg",
    style: {
      color: 'var(--fg-2)'
    }
  }, "The foreground title runs Easy Anti-Cheat. Capture is scoped to single-player / benchmark scenes to avoid conflicts."))), state === 'ready' && /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary hd-btn--block hd-btn--lg",
    onClick: () => setState('capturing')
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "circle",
    size: 16
  }), " Start capture"), state === 'capturing' && /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--danger hd-btn--block hd-btn--lg",
    onClick: () => setState('complete')
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "square",
    size: 14
  }), " Stop & analyze"), state === 'complete' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--info",
    style: {
      padding: '10px 12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "shield-check",
    size: 18
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg",
    style: {
      color: 'var(--fg-2)'
    }
  }, "Payload signed & ready to upload."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary",
    style: {
      flex: 1
    },
    onClick: () => setState('ready')
  }, "Discard"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary",
    style: {
      flex: 2
    }
  }, /*#__PURE__*/React.createElement(DIcon, {
    n: "upload",
    size: 16
  }), " Upload & share"))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-4)',
      textAlign: 'center',
      marginTop: 14
    }
  }, state === 'ready' && 'Press Shift + F11 in-game to start hands-free.', state === 'capturing' && 'Recommended capture length: 60 seconds.', state === 'complete' && 'Uploads open the run report in your browser.'))));
}
Object.assign(window, {
  CaptureClient
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/desktop/CaptureClient.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/AppShell.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Heimdall Web Hub — shared app chrome (top bar + footer).
const Icon = ({
  n,
  size,
  style,
  ...p
}) => /*#__PURE__*/React.createElement("i", _extends({
  "data-lucide": n,
  style: {
    width: size || 18,
    height: size || 18,
    ...style
  }
}, p));
function TopBar({
  route,
  onNavigate,
  onUpload
}) {
  const nav = [{
    id: 'run',
    label: 'Run report'
  }, {
    id: 'game',
    label: 'Games'
  }, {
    id: 'compare',
    label: 'Compare'
  }];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      height: 'var(--topbar-h)',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-6)',
      padding: '0 var(--space-6)',
      borderBottom: '1px solid var(--line-1)',
      background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)',
      backdropFilter: 'var(--blur-md)',
      position: 'sticky',
      top: 0,
      zIndex: 20
    }
  }, /*#__PURE__*/React.createElement("a", {
    onClick: () => onNavigate('run'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo-mark.svg",
    width: "28",
    height: "28",
    alt: ""
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-subheading)',
      fontWeight: 'var(--weight-bold)',
      letterSpacing: 'var(--tracking-tight)',
      color: 'var(--fg-1)'
    }
  }, "Heimdall")), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: 'flex',
      gap: '2px',
      marginLeft: 'var(--space-2)'
    }
  }, nav.map(n => /*#__PURE__*/React.createElement("button", {
    key: n.id,
    className: `hd-tab${route === n.id ? ' hd-tab--active' : ''}`,
    onClick: () => onNavigate(n.id),
    style: {
      padding: '0 12px',
      height: '34px',
      whiteSpace: 'nowrap'
    }
  }, n.label))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "hd-input__wrap",
    style: {
      width: 220
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-input__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "search",
    size: 16
  })), /*#__PURE__*/React.createElement("input", {
    className: "hd-input",
    placeholder: "Search games, GPUs\u2026",
    style: {
      height: '36px'
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary",
    onClick: onUpload
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "upload",
    size: 16
  }), " Upload log"), /*#__PURE__*/React.createElement("button", {
    className: "hd-iconbtn hd-iconbtn--solid",
    "aria-label": "Account",
    onClick: () => onNavigate('account')
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "user",
    size: 18
  })));
}
Object.assign(window, {
  TopBar,
  Icon
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/AppShell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/GamePage.jsx
try { (() => {
// Heimdall Web Hub — aggregate Game page (distributions + filters).
function GamePage() {
  const [verified, setVerified] = React.useState(true);
  const [gpu, setGpu] = React.useState('4070');
  const [workload, setWorkload] = React.useState('benchmark');
  // Sample counts per GPU bucket drive the §17.4 cold-start threshold (~30).
  const SAMPLES = {
    '4070': 412,
    '4090': 156,
    '7800xt': 63,
    'b580': 7
  };
  const GPU_LABEL = {
    '4070': 'RTX 4070',
    '4090': 'RTX 4090',
    '7800xt': 'RX 7800 XT',
    'b580': 'Arc B580'
  };
  const allRows = [{
    gpu: 'RTX 4090',
    cpu: '7800X3D',
    avg: 198,
    p1: 142,
    p01: 110,
    by: 'hardwarecanucks',
    v: true,
    scene: 'benchmark'
  }, {
    gpu: 'RTX 4070',
    cpu: '7800X3D',
    avg: 145,
    p1: 98,
    p01: 71,
    by: 'you',
    v: false,
    me: true,
    scene: 'benchmark'
  }, {
    gpu: 'RX 7800 XT',
    cpu: '5800X',
    avg: 131,
    p1: 88,
    p01: 64,
    by: 'frame_chaser',
    v: true,
    scene: 'gameplay'
  }, {
    gpu: 'RTX 4070',
    cpu: '13600K',
    avg: 139,
    p1: 91,
    p01: 66,
    by: 'anon',
    v: false,
    scene: 'gameplay'
  }, {
    gpu: 'Arc B580',
    cpu: '7600',
    avg: 96,
    p1: 61,
    p01: 44,
    by: 'intel_labs',
    v: true,
    scene: 'benchmark'
  }];
  const rows = allRows.filter(r => workload === 'all' || r.scene === workload);
  const sampleN = SAMPLES[gpu];
  const enough = sampleN >= 30;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: 'var(--space-8) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      marginBottom: '4px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Aggregate \xB7 1,284 public runs")), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      color: 'var(--fg-1)'
    }
  }, "Cyberpunk 2077"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)',
      marginTop: '4px'
    }
  }, "Where your run sits in the crowd, by hardware configuration."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 'var(--space-3)',
      marginTop: 'var(--space-6)',
      padding: 'var(--space-3)',
      background: 'var(--bg-raised)',
      border: '1px solid var(--line-1)',
      borderRadius: 'var(--radius-md)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-select",
    style: {
      width: 168
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: gpu,
    onChange: e => setGpu(e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "4070"
  }, "GPU: RTX 4070"), /*#__PURE__*/React.createElement("option", {
    value: "4090"
  }, "GPU: RTX 4090"), /*#__PURE__*/React.createElement("option", {
    value: "7800xt"
  }, "GPU: RX 7800 XT"), /*#__PURE__*/React.createElement("option", {
    value: "b580"
  }, "GPU: Arc B580")), /*#__PURE__*/React.createElement("span", {
    className: "hd-select__chev"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "chevron-down",
    size: 16
  }))), /*#__PURE__*/React.createElement("span", {
    className: "hd-tag"
  }, "1440p", /*#__PURE__*/React.createElement("span", {
    className: "hd-tag__close"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "x",
    size: 14
  }))), /*#__PURE__*/React.createElement("span", {
    className: "hd-tag"
  }, "DX12", /*#__PURE__*/React.createElement("span", {
    className: "hd-tag__close"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "x",
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    className: "hd-segmented",
    role: "group",
    "aria-label": "Workload"
  }, /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${workload === 'benchmark' ? ' hd-segmented__opt--active' : ''}`,
    onClick: () => setWorkload('benchmark')
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "flask-conical",
    size: 14
  }), " Benchmark scene"), /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${workload === 'gameplay' ? ' hd-segmented__opt--active' : ''}`,
    onClick: () => setWorkload('gameplay')
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "gamepad-2",
    size: 14
  }), " Gameplay"), /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${workload === 'all' ? ' hd-segmented__opt--active' : ''}`,
    onClick: () => setWorkload('all')
  }, "All")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("label", {
    className: "hd-switch"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    checked: verified,
    onChange: e => setVerified(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__thumb"
  })), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__label"
  }, "Verified only"))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 'var(--space-3)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "info",
    size: 13
  }), " Aggregates compare like workloads only \u2014 freeform gameplay is noisier than the canned benchmark scene."), enough ? /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Avg FPS distribution \xB7 ", GPU_LABEL[gpu]), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, sampleN, " runs"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--brand"
  }, "You: 73rd percentile"))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card hd-card--inset",
    style: {
      padding: 'var(--space-4) var(--space-3) var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement(BellCurve, {
    markerPct: 0.73,
    height: 150
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '0 4px',
      font: 'var(--type-overline)',
      color: 'var(--fg-4)',
      letterSpacing: 'var(--tracking-wide)'
    }
  }, /*#__PURE__*/React.createElement("span", null, "96"), /*#__PURE__*/React.createElement("span", null, "120"), /*#__PURE__*/React.createElement("span", null, "145 \u25C2 you"), /*#__PURE__*/React.createElement("span", null, "168"), /*#__PURE__*/React.createElement("span", null, "192"))))) : /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, GPU_LABEL[gpu]), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--warn"
  }, sampleN, " runs")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--info"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "info",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "Insufficient data for a distribution"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, "Only ", sampleN, " runs exist for this configuration \u2014 below the 30-run minimum. Showing individual runs instead of a curve; a distribution over a handful of runs would be noise, not signal."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-2)'
    }
  }, [{
    avg: 96,
    by: 'intel_labs',
    v: true
  }, {
    avg: 94,
    by: 'b580_owner',
    v: false
  }, {
    avg: 89,
    by: 'anon',
    v: false
  }].map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 'var(--space-3) var(--space-4)',
      background: 'var(--bg-inset)',
      border: '1px solid var(--line-1)',
      borderRadius: 3
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)'
    }
  }, r.by, r.v && /*#__PURE__*/React.createElement(Icon, {
    n: "shield-check",
    size: 14,
    style: {
      color: 'var(--brand-teal)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--tier-avg)',
      fontWeight: 600
    }
  }, r.avg, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-3)',
      fontWeight: 400
    }
  }, "avg fps"))))))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Submissions"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, rows.length, " shown")), /*#__PURE__*/React.createElement("table", {
    style: {
      width: '100%',
      borderCollapse: 'collapse'
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, ['GPU', 'CPU', 'Scene', 'Avg', '1% Low', '0.1% Low', 'By'].map((h, i) => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      textAlign: i > 2 && i < 6 ? 'right' : 'left',
      font: 'var(--type-overline)',
      letterSpacing: 'var(--tracking-wide)',
      textTransform: 'uppercase',
      color: 'var(--fg-3)',
      padding: '10px var(--space-5)',
      borderBottom: '1px solid var(--line-2)'
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: i,
    style: {
      background: r.me ? 'var(--brand-teal-dim)' : 'transparent'
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)',
      font: 'var(--type-body)',
      color: 'var(--fg-1)'
    }
  }, r.gpu), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)',
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)'
    }
  }, r.cpu), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: `hd-badge hd-badge--${r.scene === 'benchmark' ? 'info' : 'neutral'}`
  }, r.scene === 'benchmark' ? 'Bench' : 'Play')), /*#__PURE__*/React.createElement("td", {
    "data-mono": true,
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)',
      textAlign: 'right',
      font: 'var(--type-data)',
      color: 'var(--tier-avg)',
      fontWeight: 600
    }
  }, r.avg), /*#__PURE__*/React.createElement("td", {
    "data-mono": true,
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)',
      textAlign: 'right',
      font: 'var(--type-data)',
      color: 'var(--fg-1)'
    }
  }, r.p1), /*#__PURE__*/React.createElement("td", {
    "data-mono": true,
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)',
      textAlign: 'right',
      font: 'var(--type-data)',
      color: 'var(--fg-2)'
    }
  }, r.p01), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: '12px var(--space-5)',
      borderBottom: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)'
    }
  }, r.by, r.v && /*#__PURE__*/React.createElement(Icon, {
    n: "shield-check",
    size: 14,
    style: {
      color: 'var(--brand-teal)'
    }
  })))))))));
}
Object.assign(window, {
  GamePage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/GamePage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/RunPage.jsx
try { (() => {
// Heimdall Web Hub — the shareable Run Report page (flagship view).
function StatTile({
  label,
  value,
  unit,
  accent,
  delta,
  deltaDir
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "hd-stat"
  }, accent && /*#__PURE__*/React.createElement("div", {
    className: "hd-stat__accent",
    style: {
      background: accent
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__value"
  }, value, unit && /*#__PURE__*/React.createElement("span", {
    className: "hd-stat__unit"
  }, unit)), delta && /*#__PURE__*/React.createElement("span", {
    className: `hd-stat__delta hd-stat__delta--${deltaDir || 'up'}`
  }, /*#__PURE__*/React.createElement(Icon, {
    n: deltaDir === 'down' ? 'trending-down' : 'trending-up',
    size: 13
  }), " ", delta));
}
function SnapshotRow({
  k,
  v,
  warn
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '9px 0',
      borderBottom: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-3)'
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: warn ? 'var(--warn)' : 'var(--fg-1)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px'
    }
  }, warn && /*#__PURE__*/React.createElement(Icon, {
    n: "triangle-alert",
    size: 13,
    style: {
      color: 'var(--warn)'
    }
  }), v));
}
function RunPage({
  showStutters = true,
  onNavigate
}) {
  const [units, setUnits] = React.useState('ms');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: 'var(--space-8) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--space-4)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 280
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      marginBottom: '6px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--good"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-badge__dot"
  }), "Validated"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--brand"
  }, "DLSS 3"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, "Public")), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      color: 'var(--fg-1)'
    }
  }, "Cyberpunk 2077"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)',
      marginTop: '4px'
    }
  }, "Ultra \xB7 Ray Tracing: Overdrive \xB7 1440p \xB7 DX12 \xB7 62s capture")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary",
    onClick: () => onNavigate && onNavigate('compare')
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "git-compare",
    size: 16
  }), " Compare"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary",
    onClick: () => onNavigate && onNavigate('export')
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "clapperboard",
    size: 16
  }), " Export video"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "share-2",
    size: 16
  }), " Share"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Avg FPS",
    value: "144.7",
    accent: "var(--tier-avg)"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "1% Low",
    value: "98.2",
    accent: "var(--tier-p1)"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "0.1% Low",
    value: "71.0",
    accent: "var(--tier-p01)"
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Generated frames",
    value: "38",
    unit: "%",
    accent: "var(--brand-violet)"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 340px',
      gap: 'var(--space-5)',
      marginTop: 'var(--space-5)',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Frame-time progression"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: 999,
      background: 'var(--chart-stutter)'
    }
  }), " stutter"), /*#__PURE__*/React.createElement("div", {
    className: "hd-segmented"
  }, /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${units === 'ms' ? ' hd-segmented__opt--active' : ''}`,
    onClick: () => setUnits('ms')
  }, "ms"), /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${units === 'fps' ? ' hd-segmented__opt--active' : ''}`,
    onClick: () => setUnits('fps')
  }, "FPS")))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      padding: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card hd-card--inset",
    style: {
      padding: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement(FrameTimeChart, {
    seed: 7,
    height: 260,
    showStutters: showStutters
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: '14px'
    }
  }, "Smoothness tiers"), /*#__PURE__*/React.createElement(SmoothnessBars, {
    confidence: "low"
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Diagnostics"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--warn"
  }, "4 issues")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--bad"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "circle-x",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "VRAM saturation stutters"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, "Spikes correlate with 100% VRAM use. Lower texture quality."))), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--warn"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "triangle-alert",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "RAM below rated speed"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, "Running at 4800 MHz vs rated 6000 \u2014 enable EXPO in BIOS."))), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--warn"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "cpu",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "CPU bottleneck in town"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, "CPU at 96% while GPU dropped to 61% during the market scene \u2014 frames are CPU-bound there."))), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag hd-diag--info"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "download",
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, "Newer GPU driver available"), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, "566.14 installed; 572.16 is the latest game-ready driver. Update may improve RT performance."))))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Hardware snapshot")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      paddingTop: 'var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement(SnapshotRow, {
    k: "GPU",
    v: "RTX 4070"
  }), /*#__PURE__*/React.createElement(SnapshotRow, {
    k: "CPU",
    v: "Ryzen 7 7800X3D"
  }), /*#__PURE__*/React.createElement(SnapshotRow, {
    k: "Driver",
    v: "566.14"
  }), /*#__PURE__*/React.createElement(SnapshotRow, {
    k: "RAM",
    v: "4800 / 6000 MHz",
    warn: true
  }), /*#__PURE__*/React.createElement(SnapshotRow, {
    k: "OS",
    v: "Windows 11 26100"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-4)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label"
  }, "GPU load"), /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__value"
  }, "97%")), /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__fill",
    style: {
      width: '97%'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "hd-meter"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label"
  }, "VRAM"), /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__value"
  }, "11.4 / 12 GB")), /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__fill",
    style: {
      width: '95%',
      background: 'var(--bad)'
    }
  })))))))));
}
Object.assign(window, {
  RunPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/RunPage.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/charts.jsx
try { (() => {
// Heimdall UI kit — chart primitives (cosmetic recreations of the D3 views).
// Pure inline-SVG, styled with the design tokens. No real D3 — these mirror
// the visual language of the production charts for the kit.

const {
  useMemo
} = React;

// Deterministic pseudo-random so the kit looks identical every render.
function rng(seed) {
  let s = seed;
  return () => {
    s = s * 1103515245 + 12345 & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Generate a realistic frame-time trace (ms) with occasional stutters.
function genFrames(seed = 7, n = 220, base = 6.9) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let v = base + (r() - 0.5) * 1.4;
    if (r() > 0.965) v += 6 + r() * 12; // stutter spike
    if (i > 70 && i < 95) v += 1.6; // a rough patch
    out.push(Math.max(3.2, v));
  }
  return out;
}

// ── Frame-time progression plot ────────────────────────────────────────
function FrameTimeChart({
  seed = 7,
  height = 240,
  stutterThreshold = 12,
  fill = true,
  showStutters = true
}) {
  const data = useMemo(() => genFrames(seed), [seed]);
  const W = 1000,
    H = height,
    padB = 22,
    padL = 4;
  const max = Math.max(...data, 20);
  const stepX = (W - padL) / (data.length - 1);
  const y = v => H - padB - v / max * (H - padB - 8);
  const pts = data.map((v, i) => `${padL + i * stepX},${y(v)}`).join(' ');
  const area = `${padL},${H - padB} ${pts} ${padL + (data.length - 1) * stepX},${H - padB}`;
  const stutters = data.map((v, i) => ({
    v,
    i
  })).filter(d => d.v >= stutterThreshold);
  const grid = [0.25, 0.5, 0.75, 1];
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: H,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "ftFill",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#2ee6c6",
    stopOpacity: "0.28"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#2ee6c6",
    stopOpacity: "0"
  }))), grid.map((g, i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: padL,
    x2: W,
    y1: (H - padB) * g,
    y2: (H - padB) * g,
    stroke: "var(--chart-grid)",
    strokeWidth: "1"
  })), /*#__PURE__*/React.createElement("rect", {
    x: padL,
    y: y(8.3),
    width: W - padL,
    height: H - padB - y(8.3),
    fill: "var(--chart-band)"
  }), fill && /*#__PURE__*/React.createElement("polygon", {
    points: area,
    fill: "url(#ftFill)"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: pts,
    fill: "none",
    stroke: "var(--chart-frametime)",
    strokeWidth: "1.6",
    strokeLinejoin: "round"
  }), showStutters && stutters.map((d, i) => /*#__PURE__*/React.createElement("circle", {
    key: i,
    cx: padL + d.i * stepX,
    cy: y(d.v),
    r: "3.2",
    fill: "var(--chart-stutter)",
    stroke: "var(--bg-card)",
    strokeWidth: "1.5"
  })));
}

// ── Smoothness tier bars (Avg / 1% / 0.1%) ─────────────────────────────
function SmoothnessBars({
  avg = 144,
  p1 = 98,
  p01 = 71,
  max = 160,
  confidence = 'low'
}) {
  const rows = [{
    label: 'Avg FPS',
    v: avg,
    color: 'var(--tier-avg)'
  }, {
    label: '1% Low',
    v: p1,
    color: 'var(--tier-p1)'
  }, {
    label: '0.1% Low',
    v: p01,
    color: 'var(--tier-p01)',
    conf: confidence
  }];
  const confTone = {
    low: 'var(--warn)',
    medium: 'var(--info)',
    high: 'var(--good)'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '14px'
    }
  }, rows.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.label,
    style: {
      display: 'grid',
      gridTemplateColumns: '78px 1fr 56px',
      alignItems: 'center',
      gap: '12px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label",
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px'
    }
  }, r.label, r.conf && /*#__PURE__*/React.createElement("span", {
    title: `Confidence: ${r.conf} — short captures sample only a handful of worst frames`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      font: 'var(--type-overline)',
      color: confTone[r.conf],
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      border: `1px solid ${confTone[r.conf]}`,
      borderRadius: 2,
      padding: '0 4px',
      height: 14,
      opacity: 0.9
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 4,
      height: 4,
      borderRadius: 999,
      background: 'currentColor'
    }
  }), r.conf)), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '14px',
      background: 'var(--bg-inset)',
      borderRadius: 'var(--radius-pill)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${r.v / max * 100}%`,
      height: '100%',
      background: r.color,
      borderRadius: 'var(--radius-pill)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-1)',
      textAlign: 'right'
    }
  }, r.v))));
}

// ── Bell-curve distribution (where this run sits in the crowd) ─────────
function BellCurve({
  markerPct = 0.72,
  height = 150
}) {
  const W = 1000,
    H = height,
    padB = 20;
  const curve = [];
  for (let i = 0; i <= 100; i++) {
    const x = i / 100;
    const g = Math.exp(-Math.pow((x - 0.5) * 3.2, 2)); // gaussian
    curve.push([x * W, H - padB - g * (H - padB - 10)]);
  }
  const line = curve.map(p => p.join(',')).join(' ');
  const area = `0,${H - padB} ${line} ${W},${H - padB}`;
  const mx = markerPct * W;
  const myG = Math.exp(-Math.pow((markerPct - 0.5) * 3.2, 2));
  const my = H - padB - myG * (H - padB - 10);
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: H,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "bellFill",
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "0"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#2ee6c6",
    stopOpacity: "0.18"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "55%",
    stopColor: "#4d9fff",
    stopOpacity: "0.16"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#8b7bff",
    stopOpacity: "0.18"
  }))), /*#__PURE__*/React.createElement("polygon", {
    points: area,
    fill: "url(#bellFill)"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: line,
    fill: "none",
    stroke: "var(--brand-blue)",
    strokeWidth: "1.6"
  }), /*#__PURE__*/React.createElement("line", {
    x1: mx,
    x2: mx,
    y1: my - 6,
    y2: H - padB,
    stroke: "var(--brand-teal)",
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: mx,
    cy: my - 6,
    r: "4.5",
    fill: "var(--brand-teal)",
    stroke: "var(--bg-card)",
    strokeWidth: "2"
  }));
}
Object.assign(window, {
  FrameTimeChart,
  SmoothnessBars,
  BellCurve,
  genFrames
});

// ── Dual frame-time overlay (Before vs After) ──────────────────────────
function DualFrameTimeChart({
  seedA = 21,
  seedB = 7,
  baseA = 8.6,
  baseB = 6.9,
  height = 220,
  fill = true
}) {
  const a = useMemo(() => genFrames(seedA, 220, baseA), [seedA, baseA]);
  const b = useMemo(() => genFrames(seedB, 220, baseB), [seedB, baseB]);
  const W = 1000,
    H = height,
    padB = 22,
    padL = 4;
  const max = Math.max(...a, ...b, 20);
  const stepX = (W - padL) / (a.length - 1);
  const y = v => H - padB - v / max * (H - padB - 8);
  const line = data => data.map((v, i) => `${padL + i * stepX},${y(v)}`).join(' ');
  const areaB = `${padL},${H - padB} ${line(b)} ${padL + (b.length - 1) * stepX},${H - padB}`;
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: H,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "dualFill",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#2ee6c6",
    stopOpacity: "0.22"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#2ee6c6",
    stopOpacity: "0"
  }))), [0.25, 0.5, 0.75, 1].map((g, i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: padL,
    x2: W,
    y1: (H - padB) * g,
    y2: (H - padB) * g,
    stroke: "var(--chart-grid)",
    strokeWidth: "1"
  })), fill && /*#__PURE__*/React.createElement("polygon", {
    points: areaB,
    fill: "url(#dualFill)"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: line(a),
    fill: "none",
    stroke: "var(--fg-4)",
    strokeWidth: "1.5",
    strokeLinejoin: "round",
    strokeDasharray: "4 3"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: line(b),
    fill: "none",
    stroke: "var(--brand-teal)",
    strokeWidth: "1.8",
    strokeLinejoin: "round"
  }));
}

// ── Grouped before/after smoothness bars ───────────────────────────────
function CompareBars({
  rows,
  max = 220
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '16px'
    }
  }, rows.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.label
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: '6px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label"
  }, r.label), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-3)'
    }
  }, r.a, r.unit, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-4)'
    }
  }, "\u2192"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--fg-1)'
    }
  }, r.b, r.unit))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: '8px',
      background: 'var(--bg-inset)',
      borderRadius: 'var(--radius-pill)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(100, r.a / max * 100)}%`,
      height: '100%',
      background: 'var(--fg-4)',
      borderRadius: 'var(--radius-pill)'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '8px',
      background: 'var(--bg-inset)',
      borderRadius: 'var(--radius-pill)',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(100, r.b / max * 100)}%`,
      height: '100%',
      background: r.color || 'var(--brand-teal)',
      borderRadius: 'var(--radius-pill)'
    }
  }))))));
}
Object.assign(window, {
  FrameTimeChart,
  SmoothnessBars,
  BellCurve,
  genFrames,
  DualFrameTimeChart,
  CompareBars
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/charts.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/extras.jsx
try { (() => {
// Heimdall Web Hub — Upload/ingest + Before/After compare screens.
function UploadPage({
  onParsed
}) {
  const [stage, setStage] = React.useState('idle'); // idle | parsing | done | batch
  const [files, setFiles] = React.useState([]);
  React.useEffect(() => {
    if (stage === 'parsing') {
      const t = setTimeout(() => setStage('done'), 1400);
      return () => clearTimeout(t);
    }
  }, [stage]);

  // §11.8 — each file parses + uploads independently; partial failures are fine.
  const BATCH = [{
    name: 'Cyberpunk_Ultra_RT.csv',
    frames: 14902,
    ms: 300
  }, {
    name: 'Cyberpunk_DLSS_Q.csv',
    frames: 16110,
    ms: 700
  }, {
    name: 'RDR2_benchmark.csv',
    frames: 9981,
    ms: 1100
  }, {
    name: 'Hogwarts_1440p.json',
    frames: 0,
    ms: 1500,
    err: 'Unrecognized column layout'
  }, {
    name: 'Starfield_NewAtlantis.csv',
    frames: 21044,
    ms: 1900
  }];
  const startBatch = () => {
    setStage('batch');
    setFiles(BATCH.map(f => ({
      ...f,
      status: 'queued'
    })));
    BATCH.forEach((f, i) => {
      setTimeout(() => setFiles(prev => prev.map((p, j) => j === i ? {
        ...p,
        status: 'working'
      } : p)), f.ms - 250);
      setTimeout(() => setFiles(prev => prev.map((p, j) => j === i ? {
        ...p,
        status: f.err ? 'error' : 'done'
      } : p)), f.ms);
    });
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 720,
      margin: '0 auto',
      padding: 'var(--space-12) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Ingest"), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      color: 'var(--fg-1)',
      marginTop: '4px'
    }
  }, "Upload a benchmark log"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)',
      marginTop: '6px'
    }
  }, "Drag a CapFrameX, PresentMon, or MangoHud export. We parse it in your browser \u2014 no account needed."), /*#__PURE__*/React.createElement("div", {
    onClick: () => stage === 'idle' && setStage('parsing'),
    style: {
      marginTop: 'var(--space-6)',
      border: '1.5px dashed var(--line-3)',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-raised)',
      padding: 'var(--space-12)',
      textAlign: 'center',
      cursor: 'pointer'
    }
  }, stage === 'idle' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 56,
      height: 56,
      margin: '0 auto var(--space-4)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--brand-teal-dim)',
      color: 'var(--brand-teal)',
      display: 'grid',
      placeItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "upload-cloud",
    size: 28
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "Drop your log here"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-3)',
      marginTop: '4px'
    }
  }, "or click to browse \xB7 .csv .json \xB7 up to 150 files")), stage === 'parsing' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-spinner",
    style: {
      width: 28,
      height: 28
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "Parsing CyberpunkBenchmark.csv\u2026"), /*#__PURE__*/React.createElement("p", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-3)'
    }
  }, "14,902 frames \xB7 computing summary")), stage === 'done' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 48,
      height: 48,
      borderRadius: 999,
      background: 'var(--good-dim)',
      color: 'var(--good)',
      display: 'grid',
      placeItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "check",
    size: 26
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "Parsed \u2014 144.7 avg FPS"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary",
    onClick: e => {
      e.stopPropagation();
      onParsed && onParsed();
    }
  }, "View run report ", /*#__PURE__*/React.createElement(Icon, {
    n: "arrow-right",
    size: 16
  }))), stage === 'batch' && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "folder-up",
    size: 28,
    style: {
      color: 'var(--brand-teal)'
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "Uploading 5 legacy logs"), /*#__PURE__*/React.createElement("p", {
    "data-mono": true,
    style: {
      font: 'var(--type-data)',
      color: 'var(--fg-3)'
    }
  }, "parse \u2192 sign \u2192 direct-to-R2, per file"))), stage === 'batch' && /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Batch progress"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, files.filter(f => f.status === 'done').length, " / ", files.length, " done")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-2)',
      paddingTop: 'var(--space-2)'
    }
  }, files.map(f => /*#__PURE__*/React.createElement("div", {
    key: f.name,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      padding: '8px 0',
      borderBottom: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      width: 20,
      display: 'grid',
      placeItems: 'center'
    }
  }, f.status === 'queued' && /*#__PURE__*/React.createElement(Icon, {
    n: "clock",
    size: 15,
    style: {
      color: 'var(--fg-4)'
    }
  }), f.status === 'working' && /*#__PURE__*/React.createElement("span", {
    className: "hd-spinner",
    style: {
      width: 15,
      height: 15
    }
  }), f.status === 'done' && /*#__PURE__*/React.createElement(Icon, {
    n: "check",
    size: 16,
    style: {
      color: 'var(--good)'
    }
  }), f.status === 'error' && /*#__PURE__*/React.createElement(Icon, {
    n: "x",
    size: 16,
    style: {
      color: 'var(--bad)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      flex: 1,
      font: 'var(--type-data)',
      color: f.status === 'error' ? 'var(--fg-2)' : 'var(--fg-1)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, f.name), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-caption)',
      color: f.status === 'error' ? 'var(--bad)' : 'var(--fg-3)'
    }
  }, f.status === 'error' ? f.err : f.status === 'done' ? `${f.frames.toLocaleString()} frames` : f.status === 'working' ? 'parsing…' : 'queued'))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 'var(--space-2)'
    }
  }, "One bad file never blocks the rest \u2014 each succeeds or fails on its own."))), stage === 'idle' && /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--ghost",
    style: {
      marginTop: 'var(--space-3)'
    },
    onClick: startBatch
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "folder-up",
    size: 16
  }), " Upload a legacy folder (batch)"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 'var(--space-6)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: 'var(--space-3)'
    }
  }, "Visibility"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "hd-check"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    defaultChecked: true
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-check__box"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "check",
    size: 13
  })), /*#__PURE__*/React.createElement("span", null, "Unlisted \u2014 link only, excluded from public averages")), /*#__PURE__*/React.createElement("label", {
    className: "hd-check"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox"
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-check__box"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "check",
    size: 13
  })), /*#__PURE__*/React.createElement("span", null, "Public \u2014 eligible for game distributions once validated")))));
}
const COMPARE_SCENARIOS = {
  expo: {
    title: 'EXPO off → EXPO on',
    chip: 'Memory tuning',
    seedA: 21,
    baseA: 8.6,
    seedB: 7,
    baseB: 6.9,
    a: {
      name: 'Run A — EXPO off',
      when: 'Mar 14 · 4800 MHz',
      config: ['1440p', 'Ultra + RT', '4800 MHz']
    },
    b: {
      name: 'Run B — EXPO on',
      when: 'Mar 14 · 6000 MHz',
      config: ['1440p', 'Ultra + RT', '6000 MHz']
    },
    verdict: {
      sev: 'good',
      title: 'Your 1% lows improved 16.7%',
      msg: 'Enabling EXPO meaningfully reduced micro-stutters while average FPS rose 10.7%.'
    },
    stats: [{
      label: 'Avg FPS',
      a: 131,
      b: 145,
      unit: '',
      better: 'up',
      color: 'var(--tier-avg)'
    }, {
      label: '1% Low',
      a: 84,
      b: 98,
      unit: '',
      better: 'up',
      color: 'var(--tier-p1)'
    }, {
      label: '0.1% Low',
      a: 58,
      b: 71,
      unit: '',
      better: 'up',
      color: 'var(--tier-p01)'
    }, {
      label: 'p99 frame-time',
      a: 17.2,
      b: 14.1,
      unit: 'ms',
      better: 'down',
      color: 'var(--brand-violet)'
    }],
    resolved: ['RAM below rated speed', 'Frequent micro-stutters'],
    remaining: ['VRAM saturation near texture streaming']
  },
  dlss: {
    title: 'DLSS off → Quality',
    chip: 'Upscaling',
    seedA: 33,
    baseA: 9.8,
    seedB: 5,
    baseB: 6.2,
    a: {
      name: 'Run A — DLSS off',
      when: 'Mar 18 · Native',
      config: ['1440p', 'Native', 'RT Overdrive']
    },
    b: {
      name: 'Run B — DLSS Quality',
      when: 'Mar 18 · Quality',
      config: ['1440p', 'DLSS Q', 'RT Overdrive']
    },
    verdict: {
      sev: 'good',
      title: 'Average FPS rose 56% with DLSS Quality',
      msg: 'Frame-time variance tightened and VRAM pressure eased — at a small fidelity cost from upscaling.'
    },
    stats: [{
      label: 'Avg FPS',
      a: 103,
      b: 161,
      unit: '',
      better: 'up',
      color: 'var(--tier-avg)'
    }, {
      label: '1% Low',
      a: 67,
      b: 112,
      unit: '',
      better: 'up',
      color: 'var(--tier-p1)'
    }, {
      label: '0.1% Low',
      a: 44,
      b: 79,
      unit: '',
      better: 'up',
      color: 'var(--tier-p01)'
    }, {
      label: 'VRAM peak',
      a: 11.8,
      b: 9.4,
      unit: ' GB',
      better: 'down',
      color: 'var(--brand-violet)'
    }],
    resolved: ['VRAM saturation stutters', 'GPU-bound below target FPS'],
    remaining: ['Mild upscaling ghosting (not measured)']
  },
  driver: {
    title: 'Driver 561.09 → 566.14',
    chip: 'Driver update',
    seedA: 14,
    baseA: 7.4,
    seedB: 9,
    baseB: 6.8,
    a: {
      name: 'Run A — 561.09',
      when: 'Feb 02',
      config: ['1440p', 'Ultra + RT', '561.09']
    },
    b: {
      name: 'Run B — 566.14',
      when: 'Mar 21',
      config: ['1440p', 'Ultra + RT', '566.14']
    },
    verdict: {
      sev: 'info',
      title: 'Modest, within run-to-run variance',
      msg: 'Average FPS rose 3.1% — real but small. 0.1% lows are within the noise floor for a 60s capture.'
    },
    stats: [{
      label: 'Avg FPS',
      a: 140,
      b: 145,
      unit: '',
      better: 'up',
      color: 'var(--tier-avg)'
    }, {
      label: '1% Low',
      a: 94,
      b: 98,
      unit: '',
      better: 'up',
      color: 'var(--tier-p1)'
    }, {
      label: '0.1% Low',
      a: 70,
      b: 71,
      unit: '',
      better: 'up',
      color: 'var(--tier-p01)'
    }, {
      label: 'p99 frame-time',
      a: 14.6,
      b: 14.1,
      unit: 'ms',
      better: 'down',
      color: 'var(--brand-violet)'
    }],
    resolved: ['Shader-comp hitches on first load'],
    remaining: ['RAM below rated speed', 'VRAM saturation stutters']
  }
};
function ConfigCard({
  run,
  tone,
  label
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      flex: 1,
      minWidth: 220
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      padding: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 10,
      height: 10,
      borderRadius: 3,
      background: tone,
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-label)',
      color: 'var(--fg-1)'
    }
  }, run.name), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, run.when)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px'
    }
  }, run.config.map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    className: "hd-badge hd-badge--neutral"
  }, c)))));
}
function ComparePage({
  scenario = 'expo',
  chartFill = true
}) {
  const s = COMPARE_SCENARIOS[scenario] || COMPARE_SCENARIOS.expo;
  const barMax = Math.max(...s.stats.filter(c => c.unit === '').map(c => c.b)) * 1.15;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: 'var(--space-8) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--space-4)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 280
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Before / after validator"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--brand"
  }, s.chip)), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      color: 'var(--fg-1)',
      marginTop: '4px'
    }
  }, s.title), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)',
      marginTop: '4px'
    }
  }, "Cyberpunk 2077 \xB7 same scene, same hardware \u2014 only the variable below changed.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-2)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "repeat",
    size: 16
  }), " Swap A / B"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "share-2",
    size: 16
  }), " Share comparison"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-5)',
      alignItems: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(ConfigCard, {
    run: s.a,
    tone: "var(--fg-4)"
  }), /*#__PURE__*/React.createElement(Icon, {
    n: "arrow-right",
    size: 20,
    style: {
      color: 'var(--fg-3)',
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement(ConfigCard, {
    run: s.b,
    tone: "var(--brand-teal)"
  })), /*#__PURE__*/React.createElement("div", {
    className: `hd-diag hd-diag--${s.verdict.sev}`,
    style: {
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: s.verdict.sev === 'good' ? 'circle-check' : 'info',
    size: 20
  })), /*#__PURE__*/React.createElement("div", {
    className: "hd-diag__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__title"
  }, s.verdict.title), /*#__PURE__*/React.createElement("span", {
    className: "hd-diag__msg"
  }, s.verdict.msg))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4,1fr)',
      gap: 'var(--space-4)',
      marginTop: 'var(--space-5)'
    }
  }, s.stats.map(c => {
    const delta = c.better === 'down' ? (c.a - c.b) / c.a * 100 : (c.b - c.a) / c.a * 100;
    const good = delta >= 0;
    return /*#__PURE__*/React.createElement("div", {
      key: c.label,
      className: "hd-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "hd-card__body"
    }, /*#__PURE__*/React.createElement("span", {
      className: "hd-stat__label"
    }, c.label), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        marginTop: '6px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      "data-mono": true,
      style: {
        font: 'var(--type-body-sm)',
        color: 'var(--fg-3)',
        textDecoration: 'line-through'
      }
    }, c.a, c.unit), /*#__PURE__*/React.createElement(Icon, {
      n: "arrow-right",
      size: 14,
      style: {
        color: 'var(--fg-4)'
      }
    }), /*#__PURE__*/React.createElement("span", {
      "data-mono": true,
      style: {
        font: 'var(--type-metric)',
        color: 'var(--fg-1)'
      }
    }, c.b, c.unit)), /*#__PURE__*/React.createElement("span", {
      className: `hd-stat__delta hd-stat__delta--${good ? 'up' : 'down'}`,
      style: {
        marginTop: '6px'
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      n: good ? 'trending-up' : 'trending-down',
      size: 13
    }), " ", good ? '+' : '', delta.toFixed(1), "%")));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 360px',
      gap: 'var(--space-5)',
      marginTop: 'var(--space-5)',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Frame-time overlay"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '14px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 0,
      borderTop: '2px dashed var(--fg-4)'
    }
  }), " Before"), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 0,
      borderTop: '2px solid var(--brand-teal)'
    }
  }), " After"))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      padding: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card hd-card--inset",
    style: {
      padding: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement(DualFrameTimeChart, {
    seedA: s.seedA,
    baseA: s.baseA,
    seedB: s.seedB,
    baseB: s.baseB,
    height: 240,
    fill: chartFill
  })))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Smoothness, before \u2192 after")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body"
  }, /*#__PURE__*/React.createElement(CompareBars, {
    max: barMax,
    rows: s.stats.filter(c => c.unit === '').map(c => ({
      label: c.label,
      a: c.a,
      b: c.b,
      unit: c.unit,
      color: c.color
    }))
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-5)',
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Resolved"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--good"
  }, s.resolved.length)), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)'
    }
  }, s.resolved.map(r => /*#__PURE__*/React.createElement("div", {
    key: r,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "circle-check",
    size: 18,
    style: {
      color: 'var(--good)',
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-1)',
      textDecoration: 'line-through',
      textDecorationColor: 'var(--fg-4)'
    }
  }, r))))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Still present"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--warn"
  }, s.remaining.length)), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-3)'
    }
  }, s.remaining.map(r => /*#__PURE__*/React.createElement("div", {
    key: r,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "triangle-alert",
    size: 18,
    style: {
      color: 'var(--warn)',
      flex: 'none'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)'
    }
  }, r)))))));
}
Object.assign(window, {
  UploadPage,
  ComparePage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/extras.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/screens.jsx
try { (() => {
// Heimdall Web Hub — Account/management (Phase 8) + Video export (Phase 11).

// ── Account / sign-in + run management + moderation (Phase 8 §20) ──────
function AccountPage() {
  const [runs, setRuns] = React.useState([{
    id: 1,
    title: 'Cyberpunk 2077 — Ultra RT',
    vis: 'public',
    date: 'Mar 14',
    verified: true
  }, {
    id: 2,
    title: 'Starfield — New Atlantis',
    vis: 'unlisted',
    date: 'Mar 09',
    verified: false
  }, {
    id: 3,
    title: 'RDR2 — benchmark scene',
    vis: 'private',
    date: 'Feb 28',
    verified: false
  }]);
  const setVis = (id, vis) => setRuns(r => r.map(x => x.id === id ? {
    ...x,
    vis
  } : x));
  const del = id => setRuns(r => r.filter(x => x.id !== id));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 880,
      margin: '0 auto',
      padding: 'var(--space-8) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Account"), /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-avatar hd-avatar--lg"
  }, "AL"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 200
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-subheading)',
      color: 'var(--fg-1)'
    }
  }, "Ada Lovelace"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--brand"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-badge__dot"
  }), "Verified reviewer")), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-3)',
      marginTop: '2px'
    }
  }, "ada@example.com \xB7 signed in with Clerk")), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "log-out",
    size: 16
  }), " Sign out"))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card",
    style: {
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "My runs"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, runs.length)), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      paddingTop: 'var(--space-2)'
    }
  }, runs.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      padding: 'var(--space-3) 0',
      borderBottom: '1px solid var(--line-1)',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 180
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-1)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px'
    }
  }, r.title, r.verified && /*#__PURE__*/React.createElement(Icon, {
    n: "shield-check",
    size: 14,
    style: {
      color: 'var(--brand-teal)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    "data-mono": true,
    style: {
      display: 'block',
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, r.date)), /*#__PURE__*/React.createElement("span", {
    className: "hd-select",
    style: {
      width: 132
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: r.vis,
    onChange: e => setVis(r.id, e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: "private"
  }, "Private"), /*#__PURE__*/React.createElement("option", {
    value: "unlisted"
  }, "Unlisted"), /*#__PURE__*/React.createElement("option", {
    value: "public"
  }, "Public")), /*#__PURE__*/React.createElement("span", {
    className: "hd-select__chev"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "chevron-down",
    size: 16
  }))), /*#__PURE__*/React.createElement("button", {
    className: "hd-iconbtn",
    "aria-label": "Delete run",
    onClick: () => del(r.id)
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "trash-2",
    size: 18
  })))), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 'var(--space-3)'
    }
  }, "Private runs 404 for everyone but you. Deleting a run also removes its stored frame data from R2."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 'var(--space-5)',
      marginTop: 'var(--space-5)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: 'var(--space-2)'
    }
  }, "Moderation"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)'
    }
  }, "Spotted an abusive game name or bad-faith upload on the public hub?"), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--secondary hd-btn--sm",
    style: {
      marginTop: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "flag",
    size: 15
  }), " Report content"))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: 'var(--space-2)'
    }
  }, "Data & privacy"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body-sm)',
      color: 'var(--fg-2)'
    }
  }, "Right to erasure \u2014 deleting your account cascades to every run and its R2 objects."), /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--danger hd-btn--sm",
    style: {
      marginTop: 'var(--space-3)'
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "trash-2",
    size: 15
  }), " Delete account")))));
}

// ── Creator video export tool (Phase 11 §27) ──────────────────────────
function ExportPage() {
  const [mode, setMode] = React.useState('transparent'); // transparent | green | png
  const [rendering, setRendering] = React.useState(false);
  const [pct, setPct] = React.useState(0);
  React.useEffect(() => {
    if (!rendering) return;
    setPct(0);
    const id = setInterval(() => setPct(p => {
      if (p >= 100) {
        clearInterval(id);
        setRendering(false);
        return 100;
      }
      return p + 4;
    }), 60);
    return () => clearInterval(id);
  }, [rendering]);
  const checker = 'repeating-conic-gradient(#1b212c 0% 25%, #11151d 0% 50%) 50% / 22px 22px';
  const previewBg = mode === 'green' ? '#00b140' : mode === 'png' ? checker : checker;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 'var(--container-max)',
      margin: '0 auto',
      padding: 'var(--space-8) var(--space-6) var(--space-16)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline"
  }, "Creator tools"), /*#__PURE__*/React.createElement("h1", {
    style: {
      font: 'var(--type-title)',
      color: 'var(--fg-1)',
      marginTop: '4px'
    }
  }, "Export overlay video"), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-body)',
      color: 'var(--fg-2)',
      marginTop: '4px'
    }
  }, "Render the scrolling frame-time chart as a transparent or green-screen clip, synced to your gameplay. Encodes in your browser \u2014 nothing leaves your machine."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 320px',
      gap: 'var(--space-5)',
      marginTop: 'var(--space-6)',
      alignItems: 'start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Preview"), /*#__PURE__*/React.createElement("span", {
    className: "hd-badge hd-badge--neutral"
  }, "1920 \xD7 1080 \xB7 60 fps")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      padding: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      background: previewBg,
      padding: 'var(--space-6) var(--space-4)',
      border: '1px solid var(--line-1)'
    }
  }, /*#__PURE__*/React.createElement(FrameTimeChart, {
    seed: 4,
    height: 150,
    fill: true,
    showStutters: true
  })), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)',
      marginTop: 'var(--space-3)'
    }
  }, mode === 'transparent' && 'Transparent — WebM/VP9 with alpha (checkerboard = empty pixels).', mode === 'green' && 'Green-screen — solid chroma key; the universal editor fallback (MP4).', mode === 'png' && 'PNG sequence — zipped frames with alpha, for editors without WebM-alpha.'))), /*#__PURE__*/React.createElement("div", {
    className: "hd-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-card__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-card__title"
  }, "Output")), /*#__PURE__*/React.createElement("div", {
    className: "hd-card__body",
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "heimdall-overline",
    style: {
      display: 'block',
      marginBottom: 'var(--space-2)'
    }
  }, "Background"), /*#__PURE__*/React.createElement("div", {
    className: "hd-segmented",
    style: {
      width: '100%'
    },
    role: "group"
  }, /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${mode === 'transparent' ? ' hd-segmented__opt--active' : ''}`,
    style: {
      flex: 1
    },
    onClick: () => setMode('transparent')
  }, "Alpha"), /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${mode === 'green' ? ' hd-segmented__opt--active' : ''}`,
    style: {
      flex: 1
    },
    onClick: () => setMode('green')
  }, "Green"), /*#__PURE__*/React.createElement("button", {
    className: `hd-segmented__opt${mode === 'png' ? ' hd-segmented__opt--active' : ''}`,
    style: {
      flex: 1
    },
    onClick: () => setMode('png')
  }, "PNG seq"))), /*#__PURE__*/React.createElement("label", {
    className: "hd-switch"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    defaultChecked: true
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__thumb"
  })), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__label"
  }, "Sync to gameplay clip")), /*#__PURE__*/React.createElement("label", {
    className: "hd-switch"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    defaultChecked: true
  }), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__thumb"
  })), /*#__PURE__*/React.createElement("span", {
    className: "hd-switch__label"
  }, "Highlight stutters")), rendering || pct === 100 ? /*#__PURE__*/React.createElement("div", {
    className: "hd-meter"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__label"
  }, pct === 100 ? 'Encoded' : 'Encoding (WebCodecs)'), /*#__PURE__*/React.createElement("span", {
    className: "hd-meter__value"
  }, pct, "%")), /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "hd-meter__fill",
    style: {
      width: `${pct}%`,
      background: pct === 100 ? 'var(--good)' : 'var(--brand-teal)'
    }
  }))) : null, pct === 100 ? /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary hd-btn--block"
  }, /*#__PURE__*/React.createElement(Icon, {
    n: "download",
    size: 16
  }), " Download .", mode === 'png' ? 'zip' : mode === 'green' ? 'mp4' : 'webm') : /*#__PURE__*/React.createElement("button", {
    className: "hd-btn hd-btn--primary hd-btn--block",
    disabled: rendering,
    onClick: () => setRendering(true)
  }, rendering ? 'Rendering…' : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Icon, {
    n: "clapperboard",
    size: 16
  }), " Render in browser")), /*#__PURE__*/React.createElement("p", {
    style: {
      font: 'var(--type-caption)',
      color: 'var(--fg-3)'
    }
  }, "WebCodecs ", /*#__PURE__*/React.createElement("code", {
    style: {
      font: 'var(--type-data)'
    }
  }, "VideoEncoder"), " where available; falls back to a PNG sequence otherwise.")))));
}
Object.assign(window, {
  AccountPage,
  ExportPage
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web/tweaks-panel.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
// Exports (to window): useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider,
//   TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// TweakRadio is the segmented control for 2–3 short options (auto-falls-back to
// TweakSelect past ~16/~10 chars per label); reach for TweakSelect directly when
// options are many or long. For color tweaks always curate 3-4 options rather than
// a free picker; an option can also be a whole 2–5 color palette (the stored value
// is the array). The Tweak* controls are a floor, not a ceiling — build custom
// controls inside the panel if a tweak calls for UI they don't cover.
/* END USAGE */
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Stat = __ds_scope.Stat;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Diagnostic = __ds_scope.Diagnostic;

__ds_ns.Meter = __ds_scope.Meter;

__ds_ns.Spinner = __ds_scope.Spinner;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Segmented = __ds_scope.Segmented;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

})();

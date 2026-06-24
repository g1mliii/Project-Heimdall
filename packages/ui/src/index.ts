// @heimdall/ui — public barrel.
//
// Import design-system primitives from HERE, never from component internals
// (the adherence lint forbids deep imports). Apps also import the stylesheet once:
//   import '@heimdall/ui/styles.css'
//
// NOTE: components currently ship as .jsx + .d.ts exactly as authored by the design
// system. Phase 1 (§3a) finalizes the TS/build wiring when apps/web first consumes them.

export { Button } from './components/core/Button.jsx';
export { IconButton } from './components/core/IconButton.jsx';
export { Badge } from './components/core/Badge.jsx';
export { Tag } from './components/core/Tag.jsx';
export { Card } from './components/core/Card.jsx';
export { Stat } from './components/core/Stat.jsx';
export { Avatar } from './components/core/Avatar.jsx';

export { Input } from './components/forms/Input.jsx';
export { Select } from './components/forms/Select.jsx';
export { Switch } from './components/forms/Switch.jsx';
export { Checkbox } from './components/forms/Checkbox.jsx';
export { Segmented } from './components/forms/Segmented.jsx';

export { Diagnostic } from './components/feedback/Diagnostic.jsx';
export { Meter } from './components/feedback/Meter.jsx';
export { Tooltip } from './components/feedback/Tooltip.jsx';
export { Spinner } from './components/feedback/Spinner.jsx';

export { Tabs } from './components/navigation/Tabs.jsx';

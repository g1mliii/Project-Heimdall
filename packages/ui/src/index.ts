// @heimdall/ui — public barrel.
//
// Import design-system primitives from HERE, never from component internals
// (the adherence lint forbids deep imports). Apps also import the stylesheet once:
//   import '@heimdall/ui/styles.css'
//
// Components are typed .tsx, built to dist/ by tsup (see package.json exports).

export { Button, type ButtonProps } from "./components/core/Button";
export { IconButton, type IconButtonProps } from "./components/core/IconButton";
export { Badge, type BadgeProps } from "./components/core/Badge";
export { Tag, type TagProps } from "./components/core/Tag";
export { Card, type CardProps, type CardHeaderProps } from "./components/core/Card";
export { Stat, type StatProps } from "./components/core/Stat";
export { Avatar, type AvatarProps } from "./components/core/Avatar";

export { Input, type InputProps } from "./components/forms/Input";
export { Select, type SelectProps, type SelectOption } from "./components/forms/Select";
export { Switch, type SwitchProps } from "./components/forms/Switch";
export { Checkbox, type CheckboxProps } from "./components/forms/Checkbox";
export { Segmented, type SegmentedProps, type SegmentedOption } from "./components/forms/Segmented";

export { Diagnostic, type DiagnosticProps } from "./components/feedback/Diagnostic";
export { Meter, type MeterProps } from "./components/feedback/Meter";
export { Tooltip, type TooltipProps } from "./components/feedback/Tooltip";
export { Spinner, type SpinnerProps } from "./components/feedback/Spinner";

export { Tabs, type TabsProps, type TabItem } from "./components/navigation/Tabs";

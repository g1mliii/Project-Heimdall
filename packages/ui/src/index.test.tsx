import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Card, Stat } from "./index";

// Server-render smoke tests: prove the primitives mount and emit their .hd-*
// classes. (Full visual fidelity is covered by the Playwright snapshots.)
describe("@heimdall/ui primitives render", () => {
  it("Button emits its variant class and label", () => {
    const html = renderToStaticMarkup(<Button variant="primary">Go</Button>);
    expect(html).toContain("hd-btn");
    expect(html).toContain("hd-btn--primary");
    expect(html).toContain("Go");
  });

  it("Card composes header + body", () => {
    const html = renderToStaticMarkup(
      <Card>
        <Card.Header title="Run" />
        <Card.Body>body</Card.Body>
      </Card>,
    );
    expect(html).toContain("hd-card");
    expect(html).toContain("hd-card__head");
    expect(html).toContain("hd-card__body");
  });

  it("Stat renders the numeric value in the mono value slot", () => {
    const html = renderToStaticMarkup(<Stat label="AVG FPS" value={119.8} unit="fps" />);
    expect(html).toContain("hd-stat__value");
    expect(html).toContain("119.8");
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Card, Meter, NavTabs, Stat, Table } from "./index";

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

  it("NavTabs emits links and marks the active destination", () => {
    const html = renderToStaticMarkup(
      <NavTabs
        aria-label="Primary navigation"
        currentHref="/upload"
        tabs={[
          { href: "/", label: "Benchmarks" },
          { href: "/upload", label: "Upload" },
        ]}
      />,
    );

    expect(html).toContain("<nav");
    expect(html).toContain('href="/upload"');
    expect(html).toContain('aria-current="page"');
  });

  it("Meter exposes the value as a labeled progressbar", () => {
    const html = renderToStaticMarkup(
      <Meter layout="inline" label="0.1% low" value={72.4} max={120} display="72.4" />,
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="72.4"');
    expect(html).toContain('aria-labelledby=');
  });

  it("Table keeps consumer order and emits accessible sort + numeric semantics", () => {
    const html = renderToStaticMarkup(
      <Table
        caption="Submissions"
        columns={[
          { key: "name", header: "Name", sortable: true, cell: (row) => row.name },
          { key: "fps", header: "Avg", numeric: true, align: "right", cell: (row) => row.fps },
        ]}
        rows={[
          { id: "2", name: "Second", fps: 98 },
          { id: "1", name: "First", fps: 145 },
        ]}
        rowKey={(row) => row.id}
        sort={{ key: "name", direction: "asc" }}
        onSortChange={() => undefined}
      />,
    );

    expect(html).toContain('class="hd-table"');
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain("<button");
    expect(html).toContain("data-mono");
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("First"));
  });

  it("Table renders its controlled empty state across all columns", () => {
    const html = renderToStaticMarkup(
      <Table
        caption="Submissions"
        columns={[{ key: "name", header: "Name", cell: (row: { name: string }) => row.name }]}
        rows={[]}
        rowKey={(row) => row.name}
        empty="No matching submissions."
      />,
    );
    expect(html).toContain('colSpan="1"');
    expect(html).toContain("No matching submissions.");
  });
});

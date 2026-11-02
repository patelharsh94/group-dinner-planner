import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Brand } from "../src/components";
it("UI-07 consistently brands the header Dinner Planner with Powered by Muse attribution", () => {
  render(<Brand />);
  expect(screen.getByText("Dinner Planner")).toBeTruthy();
  expect(screen.getByText("Powered by Muse")).toBeTruthy();
  expect(screen.queryByText(/^muse$/i)).toBeNull();
});

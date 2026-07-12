import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { GraphPlanCard } from "@opencode-ai/session-ui/graph-plan-card"

Object.assign(globalThis, { React: { createElement: h } })

test("renders the durable structured plan independently of assistant prose", () => {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () =>
      createComponent(GraphPlanCard, {
        card: {
          goal: "Make workflow authority visible",
          mode: "Module",
          currentTask: "Build rail",
          nextStop: "After the current module",
          moduleCount: 1,
          taskCount: 1,
          modules: [
            {
              id: "module",
              name: "Interface",
              tasks: [
                {
                  id: "task",
                  name: "Build rail",
                  verification: { criteria: ["Rail remains visible at mobile width"] },
                },
              ],
            },
          ],
        },
      }),
    root,
  )

  expect(root.textContent).toContain("Make workflow authority visible")
  expect(root.textContent).toContain("Mode: Module")
  expect(root.textContent).toContain("Current task: Build rail")
  expect(root.textContent).toContain("After the current module")
  expect(root.textContent).toContain("1 module")
  expect(root.textContent).toContain("1 atomic task")
  expect(root.querySelectorAll("ol > li")).toHaveLength(1)
  expect(root.textContent).toContain("Rail remains visible at mobile width")
  expect(root.textContent).not.toContain("graph_plan_admit")
  dispose()
  root.remove()
})

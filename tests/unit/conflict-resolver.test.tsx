import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConflictResolver from "../../src/renderer/components/timetable/ConflictResolver";
import type { ParsedCourse } from "../../src/shared/types";

const course = (name: string): ParsedCourse => ({
  name,
  teacher: `${name}老师`,
  weekday: 1,
  startPeriod: 1,
  endPeriod: 2,
  startWeek: 1,
  endWeek: 16,
});

describe("课程冲突合并", () => {
  it("同一槽位的多门课程都能保留，不因 Map 单值覆盖而丢失", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <ConflictResolver
        open
        domCourses={[course("高等数学"), course("线性代数")]}
        ocrCourses={[course("高等数学")]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认导入" }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toHaveLength(2);
    expect(
      onConfirm.mock.calls[0][0].map((item: ParsedCourse) => item.name),
    ).toEqual(["高等数学", "线性代数"]);
  });

  it("空课程名不会提交，并提示用户修正", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <ConflictResolver
        open
        domCourses={[course("")]}
        ocrCourses={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "确认导入" }),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText(/课程名为空/)).toBeInTheDocument();
  });
});

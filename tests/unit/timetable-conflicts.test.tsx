// 撞课标记组件测试：WeekView 角标渲染 + TimetablePage 保存撞课确认流程。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Course } from "../../src/shared/types";
import type { ConflictRef } from "../../src/shared/conflicts";
import WeekView from "../../src/renderer/components/timetable/WeekView";
import TimetablePage from "../../src/renderer/pages/TimetablePage";

const EXISTING: Course = {
  id: "c1",
  name: "高等数学",
  startWeek: 1,
  endWeek: 16,
  weekday: 1,
  startPeriod: 1,
  endPeriod: 2,
  color: "#4285F4",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("WeekView 撞课角标", () => {
  const noop = () => undefined;
  const baseProps = {
    courses: [EXISTING],
    currentWeek: 3,
    onWeekChange: noop,
    onEdit: noop,
    onAdd: noop,
    periodCount: 12,
  };

  it("有撞课时显示角标且悬停提示含冲突明细", () => {
    const refs: ConflictRef[] = [
      { kind: "course", id: "c2", label: "线性代数", detail: "第 1–8 周" },
    ];
    render(
      <WeekView {...baseProps} conflicts={new Map([[EXISTING.id, refs]])} />,
    );
    expect(screen.getByLabelText("撞课：1 处")).toBeInTheDocument();
    expect(
      screen.getByTitle(/撞课：与 线性代数（第 1–8 周）/),
    ).toBeInTheDocument();
  });

  it("无撞课时不显示角标", () => {
    render(<WeekView {...baseProps} conflicts={new Map()} />);
    expect(screen.queryByLabelText(/撞课：/)).not.toBeInTheDocument();
  });

  it("不传 conflicts 时保持原行为（无角标）", () => {
    render(<WeekView {...baseProps} />);
    expect(screen.queryByLabelText(/撞课：/)).not.toBeInTheDocument();
  });

  it("按学期起始日期显示当前周的日期范围和每日日期", () => {
    render(<WeekView {...baseProps} semesterStart="2026-08-17" />);
    expect(screen.getByText("8月31日 – 9月6日")).toBeInTheDocument();
    expect(screen.getByText("8月31日")).toBeInTheDocument();
    expect(screen.getByText("9月6日")).toBeInTheDocument();
  });

  it("未设置学期起始日期时显示设置提示", () => {
    render(<WeekView {...baseProps} semesterStart={null} />);
    expect(
      screen.getByText("请先在设置中填写学期起始日期"),
    ).toBeInTheDocument();
    expect(screen.queryByText("8月31日")).not.toBeInTheDocument();
  });
});

describe("TimetablePage 保存撞课确认", () => {
  const api = {
    timetable: {
      list: vi.fn(),
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getPreferences: vi.fn(),
      setSemesterStart: vi.fn(),
    },
    periodConfig: { get: vi.fn(), save: vi.fn() },
    exam: { list: vi.fn() },
    lab: { list: vi.fn() },
    schedule: { list: vi.fn() },
  };

  beforeEach(() => {
    api.timetable.list.mockResolvedValue({ ok: true, data: [EXISTING] });
    api.timetable.add.mockResolvedValue({ ok: true, data: EXISTING });
    api.timetable.getPreferences.mockResolvedValue({
      ok: true,
      data: { semesterStart: null },
    });
    api.periodConfig.get.mockResolvedValue({ ok: true, data: [] });
    api.exam.list.mockResolvedValue({ ok: true, data: [] });
    api.lab.list.mockResolvedValue({ ok: true, data: [] });
    api.schedule.list.mockResolvedValue({ ok: true, data: [] });
    Object.defineProperty(window, "api", { value: api, writable: true });
  });

  async function openDialogAndSave(name: string) {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const addButton = await screen.findByRole("button", { name: /添加课程/ });
    await user.click(addButton);
    const input = await screen.findByPlaceholderText("如 高等数学");
    await user.type(input, name);
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    return user;
  }

  it("撞课时先弹确认，确认后才写入", async () => {
    const user = await openDialogAndSave("线性代数");
    // 对话框默认周一第 1-2 节第 1-16 周，与已有「高等数学」撞课；
    // 该 antd 版本会把 confirm 标题同时渲染在 header 与 paragraph，用 findAllByText 断言
    expect((await screen.findAllByText("检测到撞课")).length).toBeGreaterThan(
      0,
    );
    expect(api.timetable.add).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "仍然保存" }));
    await waitFor(() => expect(api.timetable.add).toHaveBeenCalledTimes(1));
    expect(api.timetable.add.mock.calls[0][0]).toMatchObject({
      name: "线性代数",
    });
  });

  it("取消确认则不写入", async () => {
    const user = await openDialogAndSave("线性代数");
    expect((await screen.findAllByText("检测到撞课")).length).toBeGreaterThan(
      0,
    );
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(api.timetable.add).not.toHaveBeenCalled();
  });

  it("编辑课程但不改时间，保存时不弹撞课确认（排除自身）", async () => {
    api.timetable.update.mockResolvedValue({ ok: true, data: EXISTING });
    const user = userEvent.setup();
    render(<TimetablePage />);
    // 点击课程卡片进入编辑
    const card = await screen.findByText("高等数学");
    await user.click(card);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(api.timetable.update).toHaveBeenCalledTimes(1));
    expect(api.timetable.update.mock.calls[0][0]).toBe("c1");
    expect(screen.queryAllByText("检测到撞课")).toHaveLength(0);
  });

  it("页面显示跨板块检测降级提示（未设置学期开始日期）", async () => {
    render(<TimetablePage />);
    expect(
      await screen.findByText(
        /跨板块撞课检测（课程 vs 考试\/实验\/日程）未启用/,
      ),
    ).toBeInTheDocument();
  });
});

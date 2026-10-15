// 撞课检测共享数据加载：课程、节次配置、学期开始日期。
// 考试/实验/日程页已各自加载本板块数据，只需要这三项即可做跨板块撞课检测；
// 课程表页自己维护课程/节次（增删改后要局部刷新），另行加载学期与板块数据。
import { useCallback, useEffect, useState } from 'react';
import type { Course, PeriodConfig } from '../../shared/types';

export interface ConflictData {
  courses: Course[];
  periods: PeriodConfig[];
  semesterStart: string | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** 学期开始日期变更事件：SettingsModal 保存后广播，撞课相关页面订阅并重载。 */
export const SEMESTER_START_EVENT = 'college-toolkit:semester-start-changed';

export function notifySemesterStartChanged(): void {
  window.dispatchEvent(new CustomEvent(SEMESTER_START_EVENT));
}

export function useConflictData(): ConflictData {
  const [courses, setCourses] = useState<Course[]>([]);
  const [periods, setPeriods] = useState<PeriodConfig[]>([]);
  const [semesterStart, setSemesterStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [courseRes, periodRes, prefRes] = await Promise.all([
        window.api.timetable.list(),
        window.api.periodConfig.get(),
        window.api.timetable.getPreferences(),
      ]);
      if (!courseRes.ok || !periodRes.ok || !prefRes.ok) {
        setError(
          courseRes.error ??
            periodRes.error ??
            prefRes.error ??
            '加载撞课数据失败',
        );
        return;
      }
      setCourses(courseRes.data ?? []);
      setPeriods(periodRes.data ?? []);
      setSemesterStart(prefRes.data?.semesterStart ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { courses, periods, semesterStart, loading, error, reload };
}

// OCR 服务：基于 tesseract.js 识别课表截图并解析为课程列表。
// 首次调用时初始化 worker（加载 chi_sim 模型耗时约 5-10 秒），后续复用。
// 实现阶段：Phase 3
import { createWorker, type Worker } from 'tesseract.js';
import type { ParsedCourse } from './parsers/types';
import { ocrComponentService } from './OcrComponentService';

const COLOR_PALETTE = ['#4285F4', '#34A853', '#FBBC05', '#EA4335', '#9C27B0', '#00BCD4', '#FF9800', '#795548'];

class OcrComponentStateError extends Error {
  constructor(readonly code: 'OCR_COMPONENT_MISSING' | 'OCR_COMPONENT_INVALID') {
    super(code);
    this.name = 'OcrComponentStateError';
  }
}

function pickColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

export class OcrService {
  private static instance: OcrService | null = null;
  private initialized = false;
  private worker: Worker | null = null;
  /** 初始化锁：避免并发首次识别时重复创建 worker */
  private initPromise: Promise<void> | null = null;
  private workerGeneration = 0;

  private constructor() {}

  static getInstance(): OcrService {
    if (!OcrService.instance) {
      OcrService.instance = new OcrService();
    }
    return OcrService.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  /** 确保 worker 已就绪；并发调用时复用同一个 initPromise */
  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.initPromise) {
      const initialization = this.createWorker();
      this.initPromise = initialization;
      // 首次组件缺失、下载损坏等失败不能永久缓存 rejected Promise；下一次调用应重新检查组件。
      void initialization.catch(() => {
        if (this.initPromise === initialization) this.initPromise = null;
      });
    }
    await this.initPromise;
    // createWorker 内部已赋值 this.worker；此处用局部断言绕过 TS 的空值检查
    if (!this.worker) {
      throw new Error('OCR worker 初始化失败');
    }
    return this.worker;
  }

  private async createWorker(): Promise<void> {
    const generation = this.workerGeneration;
    const languagePath = ocrComponentService.getInstalledLanguagePath();
    if (!languagePath) {
      const status = ocrComponentService.getStatus().data;
      throw new OcrComponentStateError(status?.state === 'invalid' ? 'OCR_COMPONENT_INVALID' : 'OCR_COMPONENT_MISSING');
    }
    const componentRoot = languagePath.replace(/[\\/]chi_sim\.traineddata$/, '');
    const worker = await createWorker('chi_sim', 1, {
      langPath: componentRoot,
      cachePath: componentRoot,
      gzip: false,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          console.log(`[OcrService] 识别进度: ${Math.round(m.progress * 100)}%`);
        }
      },
    });
    if (generation !== this.workerGeneration) {
      await worker.terminate();
      return;
    }
    this.worker = worker;
  }

  /**
   * 识别图片中的文本。
   * @param imageBuffer 图片二进制数据
   * @returns 识别的纯文本
   */
  async recognize(imageBuffer: Buffer): Promise<string> {
    try {
      const worker = await this.ensureWorker();
      const { data } = await worker.recognize(imageBuffer);
      return data.text ?? '';
    } catch (err) {
      console.error(`[OcrService] 识别失败: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * 解析 OCR 文本为课程列表。
   * 策略：按行分割，每行尝试匹配 "课程名 ... 周次 节次 星期 地点" 模式。
   * OCR 识别的文本噪声大，仅提取能匹配的字段，其余留空。
   */
  parseOcrToCourses(text: string): ParsedCourse[] {
    if (!text) return [];
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const results: ParsedCourse[] = [];
    for (const line of lines) {
      const course = this.parseLine(line);
      if (course && course.name) results.push(course);
    }
    return results;
  }

  /** 解析单行 OCR 文本：尝试从中提取课程各字段 */
  private parseLine(line: string): ParsedCourse | null {
    if (line.length < 2) return null;
    const course: ParsedCourse = { color: pickColor(line) };
    // 课程名：取行首非数字部分
    const nameMatch = /^[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()·-]{1,30}/.exec(line);
    if (nameMatch) {
      course.name = nameMatch[0].trim();
    } else {
      return null;
    }
    // 周次
    const weekMatch = /(\d+)\s*[-~]\s*(\d+)\s*周/.exec(line);
    if (weekMatch) {
      course.startWeek = Number.parseInt(weekMatch[1], 10);
      course.endWeek = Number.parseInt(weekMatch[2], 10);
    }
    // 节次
    const periodMatch = /第?\s*(\d+)\s*[-~]\s*(\d+)\s*节/.exec(line);
    if (periodMatch) {
      course.startPeriod = Number.parseInt(periodMatch[1], 10);
      course.endPeriod = Number.parseInt(periodMatch[2], 10);
    } else {
      const singlePeriod = /第?\s*(\d+)\s*节/.exec(line);
      if (singlePeriod) {
        const p = Number.parseInt(singlePeriod[1], 10);
        course.startPeriod = p;
        course.endPeriod = p;
      }
    }
    // 星期
    const weekdayMatch = /周([一二三四五六日天])/.exec(line);
    if (weekdayMatch) {
      course.weekday = this.chineseToWeekday(weekdayMatch[1]);
    }
    // 地点：含 "楼/室/号" 的片段
    const locationMatch = /[\u4e00-\u9fa5A-Za-z0-9]{2,}(?:楼|室|号|栋|层)[\u4e00-\u9fa5A-Za-z0-9]*/.exec(line);
    if (locationMatch) {
      course.location = locationMatch[0];
    }
    return course;
  }

  private chineseToWeekday(ch: string): number | undefined {
    const map: Record<string, number> = {
      一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
    };
    return map[ch];
  }

  async invalidateWorker(): Promise<void> {
    this.workerGeneration += 1;
    this.initPromise = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // 终止失败忽略
      }
    }
  }

  async dispose(): Promise<void> {
    await this.invalidateWorker();
    this.initialized = false;
  }
}

export const ocrService = OcrService.getInstance();

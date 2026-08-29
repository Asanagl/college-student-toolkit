#include <windows.h>

#include <cstdio>
#include <cwctype>
#include <string>

namespace {

void write_error(const wchar_t* operation, DWORD error) {
  fwprintf(stderr, L"acm-job-runner: %ls failed (%lu)\n", operation, error);
}

std::wstring quote_argument(const wchar_t* value) {
  const std::wstring input = value == nullptr ? L"" : value;
  bool needs_quotes = input.empty();
  for (const wchar_t character : input) {
    if (iswspace(character) || character == L'"') {
      needs_quotes = true;
      break;
    }
  }
  if (!needs_quotes) return input;

  std::wstring result = L"\"";
  unsigned backslashes = 0;
  for (const wchar_t character : input) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'"');
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

std::wstring build_command_line(int argc, wchar_t** argv) {
  std::wstring command_line = quote_argument(argv[1]);
  for (int index = 2; index < argc; ++index) {
    command_line.push_back(L' ');
    command_line += quote_argument(argv[index]);
  }
  return command_line;
}

HANDLE create_kill_on_close_job() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    const DWORD error = GetLastError();
    CloseHandle(job);
    SetLastError(error);
    return nullptr;
  }
  return job;
}

void terminate_and_close(PROCESS_INFORMATION& process, HANDLE job) {
  TerminateProcess(process.hProcess, 1);
  WaitForSingleObject(process.hProcess, 3000);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(job);
}

int run_target(int argc, wchar_t** argv) {
  HANDLE job = create_kill_on_close_job();
  if (job == nullptr) {
    write_error(L"CreateJobObject/SetInformationJobObject", GetLastError());
    return 1;
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  std::wstring command_line = build_command_line(argc, argv);
  constexpr DWORD flags = CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED |
                          CREATE_NO_WINDOW;
  if (!CreateProcessW(nullptr, command_line.data(), nullptr, nullptr, TRUE,
                      flags, nullptr, nullptr, &startup, &process)) {
    write_error(L"CreateProcess", GetLastError());
    CloseHandle(job);
    return 1;
  }

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    const DWORD error = GetLastError();
    terminate_and_close(process, job);
    write_error(L"AssignProcessToJobObject", error);
    return 1;
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    terminate_and_close(process, job);
    write_error(L"ResumeThread", error);
    return 1;
  }

  const DWORD wait_result = WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  if (wait_result != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(process.hProcess, &exit_code)) {
    write_error(L"WaitForSingleObject/GetExitCodeProcess", GetLastError());
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(job);
  return static_cast<int>(exit_code);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    write_error(L"missing target command", ERROR_INVALID_PARAMETER);
    return 1;
  }
  return run_target(argc, argv);
}

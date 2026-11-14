// CalmFrame native screen capture: DXGI Desktop Duplication into shared D3D11 textures.
//
// One capture at a time. A worker thread waits for each new desktop frame, copies it into
// one slot of a small ring of shared textures, waits until the GPU has finished the copy,
// and then hands the slot to JavaScript with the texture's NT handle. The main process
// imports it with Electron's sharedTexture API (which duplicates the handle, so this file
// keeps ownership of its own) and calls release(slot) once every reference is gone. A
// busy slot is never written, so no lock is needed on the texture itself. Frames that
// arrive while every slot is busy are dropped and counted.
//
// Desktop Duplication, not Windows Graphics Capture: it draws no yellow capture border and
// leaves the cursor out of the image. It only delivers a frame when the screen changed, so
// a still screen produces no frames; the caller handles that.

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <timeapi.h>
#include <wrl/client.h>

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace {

constexpr int kSlots = 6;
// How long AcquireNextFrame waits before checking whether to stop.
constexpr UINT kAcquireTimeoutMs = 50;
// After a failure that is not "access lost", wait this long before retrying.
constexpr DWORD kRetryDelayMs = 250;

std::string Hex(HRESULT hr) {
  char buffer[16];
  std::snprintf(buffer, sizeof buffer, "0x%08X", static_cast<unsigned>(hr));
  return buffer;
}

std::string Utf8(const wchar_t* text) {
  int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return "";
  std::string out(static_cast<size_t>(size - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), size, nullptr, nullptr);
  return out;
}

struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  HANDLE handle = nullptr;
  std::atomic<bool> busy{false};
};

// Bumped on every start and stop. A queued event from an earlier generation is dropped
// instead of delivered: once capture has stopped, its slots are gone, and during
// environment teardown JavaScript can no longer run at all.
std::atomic<uint64_t> g_generation{0};

struct FrameEvent {
  uint64_t generation;
  int slot;
  uint64_t handle;
  uint32_t width;
  uint32_t height;
  double presentMs;       // QPC time of the frame's last present, in ms
  double presentEpochMs;  // the same instant as Unix epoch ms
  double readyMs;         // QPC time the copy into the slot had finished, in ms
  uint32_t accumulatedFrames;
  // True when the screen had not changed, and the latest frame is sent again so the
  // caller keeps sampling at a steady rate.
  bool repeat;
};

struct ErrorEvent {
  uint64_t generation;
  std::string message;
};

// The thread-safe-function callbacks use the plain N-API calls and check each status, so a
// call that fails (an environment shutting down) returns quietly instead of aborting the
// process the way node-addon-api's helpers do with C++ exceptions turned off.
void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number;
  if (napi_create_double(env, value, &number) == napi_ok) {
    napi_set_named_property(env, object, key, number);
  }
}

void DeliverFrame(Napi::Env env, Napi::Function callback, FrameEvent* data) {
  std::unique_ptr<FrameEvent> event(data);
  if (env == nullptr || callback.IsEmpty() || event->generation != g_generation.load()) return;
  napi_value frame;
  if (napi_create_object(env, &frame) != napi_ok) return;
  SetNumber(env, frame, "slot", event->slot);
  napi_value handle;
  if (napi_create_buffer_copy(env, sizeof event->handle, &event->handle, nullptr, &handle) !=
      napi_ok) {
    return;
  }
  napi_set_named_property(env, frame, "handle", handle);
  SetNumber(env, frame, "width", event->width);
  SetNumber(env, frame, "height", event->height);
  SetNumber(env, frame, "presentMs", event->presentMs);
  SetNumber(env, frame, "presentEpochMs", event->presentEpochMs);
  SetNumber(env, frame, "readyMs", event->readyMs);
  SetNumber(env, frame, "accumulatedFrames", event->accumulatedFrames);
  napi_value repeat;
  if (napi_get_boolean(env, event->repeat, &repeat) == napi_ok) {
    napi_set_named_property(env, frame, "repeat", repeat);
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) return;
  napi_call_function(env, undefined, callback, 1, &frame, nullptr);
}

void DeliverError(Napi::Env env, Napi::Function callback, ErrorEvent* data) {
  std::unique_ptr<ErrorEvent> event(data);
  if (env == nullptr || callback.IsEmpty() || event->generation != g_generation.load()) return;
  napi_value message;
  if (napi_create_string_utf8(env, event->message.c_str(), event->message.size(), &message) !=
      napi_ok) {
    return;
  }
  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) return;
  napi_call_function(env, undefined, callback, 1, &message, nullptr);
}

struct Stats {
  std::atomic<uint64_t> acquired{0};
  std::atomic<uint64_t> emitted{0};
  std::atomic<uint64_t> droppedNoSlot{0};
  std::atomic<uint64_t> pointerOnly{0};
  std::atomic<uint64_t> timeouts{0};
  std::atomic<uint64_t> accessLost{0};
  std::atomic<uint64_t> missedPresents{0};
  std::atomic<uint64_t> repeats{0};
};

class Capture {
 public:
  ~Capture() { Stop(); }

  // repeatMs: when the screen has not changed for this long, send the latest frame again.
  // 0 sends only changed frames.
  bool Start(Napi::Env env, Napi::Function onFrame, Napi::Function onError, double repeatMs,
             std::string* error) {
    repeatMs_ = repeatMs > 0 ? repeatMs : 0;
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    qpcFrequency_ = static_cast<double>(frequency.QuadPart);
    FILETIME now;
    LARGE_INTEGER qpcNow;
    GetSystemTimePreciseAsFileTime(&now);
    QueryPerformanceCounter(&qpcNow);
    ULARGE_INTEGER ticks;
    ticks.LowPart = now.dwLowDateTime;
    ticks.HighPart = now.dwHighDateTime;
    // FILETIME counts 100 ns steps from 1601; Unix time starts 11644473600 s later.
    epochBaseMs_ = static_cast<double>(ticks.QuadPart - 116444736000000000ULL) / 10000.0;
    qpcBase_ = qpcNow.QuadPart;

    if (!CreateDevice(error) || !CreateDuplication(error) || !CreateSlots(error)) {
      Reset();
      return false;
    }
    D3D11_QUERY_DESC queryDesc = {D3D11_QUERY_EVENT, 0};
    HRESULT hr = device_->CreateQuery(&queryDesc, &query_);
    if (FAILED(hr)) {
      *error = "CreateQuery failed: " + Hex(hr);
      Reset();
      return false;
    }

    onFrame_ = Napi::ThreadSafeFunction::New(env, onFrame, "calmframe-capture-frame", 0, 1);
    onError_ = Napi::ThreadSafeFunction::New(env, onError, "calmframe-capture-error", 0, 1);
    onFrame_.Unref(env);
    onError_.Unref(env);
    // Waits (AcquireNextFrame's timeout) otherwise round up to the 15.6 ms system tick,
    // which would turn a 16 ms repeat into about 31 ms.
    if (repeatMs_ > 0) timerPeriodSet_ = timeBeginPeriod(1) == TIMERR_NOERROR;
    generation_ = ++g_generation;
    running_ = true;
    started_ = true;
    thread_ = std::thread([this] { Loop(); });
    return true;
  }

  void Stop() {
    if (!started_) return;
    ++g_generation;
    running_ = false;
    if (thread_.joinable()) thread_.join();
    if (timerPeriodSet_) timeEndPeriod(1);
    timerPeriodSet_ = false;
    onFrame_.Release();
    onError_.Release();
    Reset();
    started_ = false;
  }

  void Release(int slot) {
    if (slot >= 0 && slot < kSlots) slots_[slot].busy = false;
  }

  double NowMs() const {
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return QpcToMs(now.QuadPart);
  }

  Napi::Object Info(Napi::Env env) const {
    Napi::Object info = Napi::Object::New(env);
    info.Set("width", width_);
    info.Set("height", height_);
    info.Set("adapter", adapterName_);
    info.Set("adapterLuid", adapterLuid_);
    info.Set("output", outputName_);
    info.Set("method", method_);
    info.Set("slots", kSlots);
    return info;
  }

  Napi::Object StatsObject(Napi::Env env) const {
    Napi::Object out = Napi::Object::New(env);
    out.Set("acquired", static_cast<double>(stats_.acquired));
    out.Set("emitted", static_cast<double>(stats_.emitted));
    out.Set("droppedNoSlot", static_cast<double>(stats_.droppedNoSlot));
    out.Set("pointerOnly", static_cast<double>(stats_.pointerOnly));
    out.Set("timeouts", static_cast<double>(stats_.timeouts));
    out.Set("accessLost", static_cast<double>(stats_.accessLost));
    out.Set("missedPresents", static_cast<double>(stats_.missedPresents));
    out.Set("repeats", static_cast<double>(stats_.repeats));
    int busy = 0;
    for (const Slot& s : slots_) busy += s.busy ? 1 : 0;
    out.Set("busySlots", busy);
    return out;
  }

 private:
  double QpcToMs(int64_t qpc) const { return static_cast<double>(qpc) * 1000.0 / qpcFrequency_; }
  double QpcToEpochMs(int64_t qpc) const {
    return epochBaseMs_ + static_cast<double>(qpc - qpcBase_) * 1000.0 / qpcFrequency_;
  }

  // The primary monitor (the output at desktop position 0,0) and the adapter that drives
  // it. Desktop Duplication fails unless the device is created on that adapter.
  bool CreateDevice(std::string* error) {
    ComPtr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
      *error = "CreateDXGIFactory1 failed: " + Hex(hr);
      return false;
    }
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a) {
      ComPtr<IDXGIOutput> output;
      for (UINT o = 0; adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; ++o) {
        DXGI_OUTPUT_DESC desc;
        if (SUCCEEDED(output->GetDesc(&desc)) && desc.AttachedToDesktop &&
            desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0) {
          adapter_ = adapter;
          output_ = output;
          outputName_ = Utf8(desc.DeviceName);
          break;
        }
        output.Reset();
      }
      if (output_) break;
      adapter.Reset();
    }
    if (!output_) {
      *error = "no primary monitor found among the DXGI outputs";
      return false;
    }
    DXGI_ADAPTER_DESC1 adapterDesc;
    if (SUCCEEDED(adapter_->GetDesc1(&adapterDesc))) {
      adapterName_ = Utf8(adapterDesc.Description);
      char luid[32];
      std::snprintf(luid, sizeof luid, "%08lX:%08lX",
                    static_cast<unsigned long>(adapterDesc.AdapterLuid.HighPart),
                    static_cast<unsigned long>(adapterDesc.AdapterLuid.LowPart));
      adapterLuid_ = luid;
    }
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
                                        D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
    hr = D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                           D3D11_SDK_VERSION, &device_, nullptr, &context_);
    if (FAILED(hr)) {
      *error = "D3D11CreateDevice failed: " + Hex(hr);
      return false;
    }
    return true;
  }

  // DuplicateOutput1 asks for BGRA even on an HDR desktop; it needs a per-monitor DPI
  // aware process (Electron is). Plain DuplicateOutput is the fallback.
  bool CreateDuplication(std::string* error) {
    duplication_.Reset();
    HRESULT hr = E_NOINTERFACE;
    ComPtr<IDXGIOutput5> output5;
    if (SUCCEEDED(output_.As(&output5))) {
      const DXGI_FORMAT formats[] = {DXGI_FORMAT_B8G8R8A8_UNORM};
      hr = output5->DuplicateOutput1(device_.Get(), 0, ARRAYSIZE(formats), formats,
                                     &duplication_);
      if (SUCCEEDED(hr)) method_ = "DuplicateOutput1";
    }
    if (FAILED(hr)) {
      ComPtr<IDXGIOutput1> output1;
      hr = output_.As(&output1);
      if (SUCCEEDED(hr)) hr = output1->DuplicateOutput(device_.Get(), &duplication_);
      if (SUCCEEDED(hr)) method_ = "DuplicateOutput";
    }
    if (FAILED(hr)) {
      *error = "DuplicateOutput failed: " + Hex(hr);
      return false;
    }
    DXGI_OUTDUPL_DESC desc;
    duplication_->GetDesc(&desc);
    if (desc.ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
      *error = "desktop format is not BGRA8 (format " + std::to_string(desc.ModeDesc.Format) + ")";
      return false;
    }
    if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
        desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
      *error = "rotated displays are not supported";
      return false;
    }
    if (width_ != 0 && (desc.ModeDesc.Width != width_ || desc.ModeDesc.Height != height_)) {
      *error = "the display size changed";
      return false;
    }
    width_ = desc.ModeDesc.Width;
    height_ = desc.ModeDesc.Height;
    return true;
  }

  bool CreateSlots(std::string* error) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width_;
    desc.Height = height_;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    for (Slot& slot : slots_) {
      HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &slot.texture);
      if (FAILED(hr)) {
        *error = "CreateTexture2D failed: " + Hex(hr);
        return false;
      }
      ComPtr<IDXGIResource1> resource;
      hr = slot.texture.As(&resource);
      if (SUCCEEDED(hr)) {
        hr = resource->CreateSharedHandle(
            nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr,
            &slot.handle);
      }
      if (FAILED(hr)) {
        *error = "CreateSharedHandle failed: " + Hex(hr);
        return false;
      }
      slot.busy = false;
    }
    return true;
  }

  int FreeSlot() {
    for (int i = 0; i < kSlots; ++i) {
      int slot = (nextSlot_ + i) % kSlots;
      if (!slots_[slot].busy) {
        nextSlot_ = (slot + 1) % kSlots;
        return slot;
      }
    }
    return -1;
  }

  void EmitError(const std::string& message) {
    auto* event = new ErrorEvent{generation_, message};
    if (onError_.NonBlockingCall(event, DeliverError) != napi_ok) delete event;
  }

  void Emit(int slot, double presentMs, double presentEpochMs, double readyMs,
            uint32_t accumulatedFrames, bool repeat) {
    auto* event = new FrameEvent{generation_,
                                 slot,
                                 reinterpret_cast<uint64_t>(slots_[slot].handle),
                                 width_,
                                 height_,
                                 presentMs,
                                 presentEpochMs,
                                 readyMs,
                                 accumulatedFrames,
                                 repeat};
    slots_[slot].busy = true;
    lastEmitMs_ = NowMs();
    if (onFrame_.NonBlockingCall(event, DeliverFrame) == napi_ok) {
      ++stats_.emitted;
      if (repeat) ++stats_.repeats;
    } else {
      slots_[slot].busy = false;
      delete event;
    }
  }

  // The screen has not changed for repeatMs: send the latest frame again, stamped now,
  // since that is what the screen shows now. If the caller still holds that slot, wait
  // another interval instead of spinning.
  void Repeat() {
    if (repeatMs_ <= 0 || lastSlot_ < 0) return;
    if (NowMs() - lastEmitMs_ < repeatMs_) return;
    if (slots_[lastSlot_].busy) {
      lastEmitMs_ = NowMs();
      return;
    }
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    Emit(lastSlot_, QpcToMs(now.QuadPart), QpcToEpochMs(now.QuadPart), QpcToMs(now.QuadPart), 0,
         true);
  }

  void Loop() {
    while (running_) {
      if (!duplication_) {
        std::string error;
        if (!CreateDuplication(&error)) {
          EmitError("recreating the duplication failed: " + error);
          Sleep(kRetryDelayMs);
          continue;
        }
      }
      // Wait for a new frame, but only until the latest one is due to be sent again.
      UINT timeout = kAcquireTimeoutMs;
      if (repeatMs_ > 0 && lastSlot_ >= 0) {
        double left = repeatMs_ - (NowMs() - lastEmitMs_);
        timeout = left > 0 ? static_cast<UINT>(left + 0.999) : 0;
      }
      DXGI_OUTDUPL_FRAME_INFO info = {};
      ComPtr<IDXGIResource> resource;
      HRESULT hr = duplication_->AcquireNextFrame(timeout, &info, &resource);
      if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        ++stats_.timeouts;
        Repeat();
        continue;
      }
      if (hr == DXGI_ERROR_ACCESS_LOST) {
        // Mode change, a full-screen app taking over, or the secure desktop (UAC).
        ++stats_.accessLost;
        duplication_.Reset();
        continue;
      }
      if (FAILED(hr)) {
        EmitError("AcquireNextFrame failed: " + Hex(hr));
        duplication_.Reset();
        Sleep(kRetryDelayMs);
        continue;
      }
      ++stats_.acquired;
      // A frame whose only change is the mouse pointer has no new desktop image.
      if (info.LastPresentTime.QuadPart == 0) {
        ++stats_.pointerOnly;
        duplication_->ReleaseFrame();
        continue;
      }
      if (info.AccumulatedFrames > 1) stats_.missedPresents += info.AccumulatedFrames - 1;
      int slot = FreeSlot();
      if (slot < 0) {
        ++stats_.droppedNoSlot;
        duplication_->ReleaseFrame();
        continue;
      }
      ComPtr<ID3D11Texture2D> desktop;
      hr = resource.As(&desktop);
      if (FAILED(hr)) {
        duplication_->ReleaseFrame();
        EmitError("the desktop image is not a texture: " + Hex(hr));
        continue;
      }
      context_->CopyResource(slots_[slot].texture.Get(), desktop.Get());
      context_->End(query_.Get());
      // Electron's import uses no keyed mutex or fence, so the copy must be complete on the
      // GPU before the handle leaves this thread. GetData with flags 0 also flushes.
      while (running_ && context_->GetData(query_.Get(), nullptr, 0, 0) == S_FALSE) {
        std::this_thread::yield();
      }
      duplication_->ReleaseFrame();
      LARGE_INTEGER ready;
      QueryPerformanceCounter(&ready);
      lastSlot_ = slot;
      Emit(slot, QpcToMs(info.LastPresentTime.QuadPart),
           QpcToEpochMs(info.LastPresentTime.QuadPart), QpcToMs(ready.QuadPart),
           info.AccumulatedFrames, false);
    }
  }

  void Reset() {
    for (Slot& slot : slots_) {
      if (slot.handle != nullptr) CloseHandle(slot.handle);
      slot.handle = nullptr;
      slot.texture.Reset();
      slot.busy = false;
    }
    query_.Reset();
    duplication_.Reset();
    context_.Reset();
    device_.Reset();
    output_.Reset();
    adapter_.Reset();
    width_ = 0;
    height_ = 0;
  }

  ComPtr<IDXGIAdapter1> adapter_;
  ComPtr<IDXGIOutput> output_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  ComPtr<ID3D11Query> query_;
  Slot slots_[kSlots];
  int nextSlot_ = 0;
  // The slot holding the newest desktop image, and when a frame was last sent.
  int lastSlot_ = -1;
  double lastEmitMs_ = 0.0;
  double repeatMs_ = 0.0;
  bool timerPeriodSet_ = false;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  std::string adapterName_;
  std::string adapterLuid_;
  std::string outputName_;
  std::string method_;
  double qpcFrequency_ = 1.0;
  double epochBaseMs_ = 0.0;
  int64_t qpcBase_ = 0;
  Stats stats_;
  uint64_t generation_ = 0;
  std::atomic<bool> running_{false};
  bool started_ = false;
  std::thread thread_;
  Napi::ThreadSafeFunction onFrame_;
  Napi::ThreadSafeFunction onError_;
};

std::unique_ptr<Capture> g_capture;

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsFunction() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "start(onFrame, onError, options) needs two functions")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (g_capture) {
    Napi::Error::New(env, "capture is already running").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Optional third argument: { repeatMs }.
  double repeatMs = 0;
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Value value = info[2].As<Napi::Object>().Get("repeatMs");
    if (value.IsNumber()) repeatMs = value.As<Napi::Number>().DoubleValue();
  }
  auto capture = std::make_unique<Capture>();
  std::string error;
  if (!capture->Start(env, info[0].As<Napi::Function>(), info[1].As<Napi::Function>(), repeatMs,
                      &error)) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_capture = std::move(capture);
  return g_capture->Info(env);
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  if (g_capture && info.Length() > 0 && info[0].IsNumber()) {
    g_capture->Release(info[0].As<Napi::Number>().Int32Value());
  }
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_capture.reset();
  return info.Env().Undefined();
}

Napi::Value GetStats(const Napi::CallbackInfo& info) {
  if (!g_capture) return info.Env().Null();
  return g_capture->StatsObject(info.Env());
}

Napi::Value Now(const Napi::CallbackInfo& info) {
  LARGE_INTEGER frequency;
  LARGE_INTEGER now;
  QueryPerformanceFrequency(&frequency);
  QueryPerformanceCounter(&now);
  return Napi::Number::New(info.Env(), static_cast<double>(now.QuadPart) * 1000.0 /
                                           static_cast<double>(frequency.QuadPart));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("release", Napi::Function::New(env, Release));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("stats", Napi::Function::New(env, GetStats));
  exports.Set("now", Napi::Function::New(env, Now));
  // Stop the worker thread before the environment goes away (window reload, app quit).
  env.AddCleanupHook([] { g_capture.reset(); });
  return exports;
}

}  // namespace

NODE_API_MODULE(calmframe_capture, Init)

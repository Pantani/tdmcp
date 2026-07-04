#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/logger.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/registration.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <queue>
#include <stdexcept>
#include <string>
#include <vector>

struct Config {
  int frames = 0;
  int calibrationFrames = 45;
  int backgroundFrames = 0;
  int debugEvery = 0;
  float wallMm = 0.0f;
  float nearMinMm = 30.0f;
  float nearMaxMm = 600.0f;
  int minPixels = 35;
  int stride = 2;
  float minSize = 0.0f;
  float maxSize = 1.0f;
  float maxWidth = 1.0f;
  float maxHeight = 1.0f;
  float cropLeft = 0.0f;
  float cropRight = 1.0f;
  float cropTop = 0.0f;
  float cropBottom = 1.0f;
  bool undistortDepth = false;
  std::string dumpDepthPpm;
};

struct Hand {
  bool present = false;
  float x = 0.0f;
  float y = 0.0f;
  float rawX = 0.0f;
  float rawY = 0.0f;
  float size = 0.0f;
  float minX = 0.0f;
  float minY = 0.0f;
  float maxX = 0.0f;
  float maxY = 0.0f;
  float centerX = 0.0f;
  float centerY = 0.0f;
  float width = 0.0f;
  float height = 0.0f;
  float openScore = 0.0f;
  int count = 0;
};

struct DetectionStats {
  int validSamples = 0;
  int foregroundSamples = 0;
  int candidateSamples = 0;
  float maxDeltaMm = 0.0f;
};

static bool readIntArg(int argc, char** argv, int& i, int& out) {
  if (i + 1 >= argc) return false;
  out = std::atoi(argv[++i]);
  return true;
}

static bool readFloatArg(int argc, char** argv, int& i, float& out) {
  if (i + 1 >= argc) return false;
  out = std::atof(argv[++i]);
  return true;
}

static Config parseArgs(int argc, char** argv) {
  Config cfg;
  for (int i = 1; i < argc; ++i) {
    const std::string arg(argv[i]);
    if (arg == "--frames") {
      if (!readIntArg(argc, argv, i, cfg.frames)) throw std::runtime_error("missing --frames value");
    } else if (arg == "--calibration-frames") {
      if (!readIntArg(argc, argv, i, cfg.calibrationFrames)) {
        throw std::runtime_error("missing --calibration-frames value");
      }
    } else if (arg == "--background-frames") {
      if (!readIntArg(argc, argv, i, cfg.backgroundFrames)) {
        throw std::runtime_error("missing --background-frames value");
      }
    } else if (arg == "--debug-every") {
      if (!readIntArg(argc, argv, i, cfg.debugEvery)) {
        throw std::runtime_error("missing --debug-every value");
      }
    } else if (arg == "--wall-mm") {
      if (!readFloatArg(argc, argv, i, cfg.wallMm)) throw std::runtime_error("missing --wall-mm value");
    } else if (arg == "--near-min-mm") {
      if (!readFloatArg(argc, argv, i, cfg.nearMinMm)) {
        throw std::runtime_error("missing --near-min-mm value");
      }
    } else if (arg == "--near-max-mm") {
      if (!readFloatArg(argc, argv, i, cfg.nearMaxMm)) {
        throw std::runtime_error("missing --near-max-mm value");
      }
    } else if (arg == "--min-pixels") {
      if (!readIntArg(argc, argv, i, cfg.minPixels)) throw std::runtime_error("missing --min-pixels value");
    } else if (arg == "--stride") {
      if (!readIntArg(argc, argv, i, cfg.stride)) throw std::runtime_error("missing --stride value");
    } else if (arg == "--min-size") {
      if (!readFloatArg(argc, argv, i, cfg.minSize)) throw std::runtime_error("missing --min-size value");
    } else if (arg == "--max-size") {
      if (!readFloatArg(argc, argv, i, cfg.maxSize)) throw std::runtime_error("missing --max-size value");
    } else if (arg == "--max-width") {
      if (!readFloatArg(argc, argv, i, cfg.maxWidth)) throw std::runtime_error("missing --max-width value");
    } else if (arg == "--max-height") {
      if (!readFloatArg(argc, argv, i, cfg.maxHeight)) throw std::runtime_error("missing --max-height value");
    } else if (arg == "--crop-left") {
      if (!readFloatArg(argc, argv, i, cfg.cropLeft)) throw std::runtime_error("missing --crop-left value");
    } else if (arg == "--crop-right") {
      if (!readFloatArg(argc, argv, i, cfg.cropRight)) throw std::runtime_error("missing --crop-right value");
    } else if (arg == "--crop-top") {
      if (!readFloatArg(argc, argv, i, cfg.cropTop)) throw std::runtime_error("missing --crop-top value");
    } else if (arg == "--crop-bottom") {
      if (!readFloatArg(argc, argv, i, cfg.cropBottom)) {
        throw std::runtime_error("missing --crop-bottom value");
      }
    } else if (arg == "--undistort-depth") {
      cfg.undistortDepth = true;
    } else if (arg == "--dump-depth-ppm") {
      if (i + 1 >= argc) throw std::runtime_error("missing --dump-depth-ppm value");
      cfg.dumpDepthPpm = argv[++i];
    } else if (arg == "--help" || arg == "-h") {
      std::cout << "Usage: kinect-wall-harp-depth-bridge [--frames n] [--wall-mm mm]"
                << " [--calibration-frames n] [--background-frames n] [--debug-every n]"
                << " [--near-min-mm mm] [--near-max-mm mm]"
                << " [--min-pixels n] [--stride n] [--min-size f] [--max-size f]"
                << " [--max-width f] [--max-height f]"
                << " [--crop-left f] [--crop-right f] [--crop-top f] [--crop-bottom f]"
                << " [--undistort-depth]"
                << " [--dump-depth-ppm path]\n";
      std::exit(0);
    } else {
      throw std::runtime_error("unknown argument: " + arg);
    }
  }
  cfg.calibrationFrames = std::max(0, cfg.calibrationFrames);
  cfg.backgroundFrames = std::max(0, cfg.backgroundFrames);
  cfg.debugEvery = std::max(0, cfg.debugEvery);
  cfg.nearMinMm = std::max(1.0f, cfg.nearMinMm);
  cfg.nearMaxMm = std::max(cfg.nearMinMm + 1.0f, cfg.nearMaxMm);
  cfg.minPixels = std::max(1, cfg.minPixels);
  cfg.stride = std::max(1, cfg.stride);
  cfg.minSize = std::max(0.0f, cfg.minSize);
  cfg.maxSize = std::max(cfg.minSize, std::min(1.0f, cfg.maxSize));
  cfg.maxWidth = std::max(0.001f, std::min(1.0f, cfg.maxWidth));
  cfg.maxHeight = std::max(0.001f, std::min(1.0f, cfg.maxHeight));
  cfg.cropLeft = std::max(0.0f, std::min(1.0f, cfg.cropLeft));
  cfg.cropRight = std::max(0.0f, std::min(1.0f, cfg.cropRight));
  cfg.cropTop = std::max(0.0f, std::min(1.0f, cfg.cropTop));
  cfg.cropBottom = std::max(0.0f, std::min(1.0f, cfg.cropBottom));
  if (cfg.cropRight <= cfg.cropLeft) cfg.cropRight = std::min(1.0f, cfg.cropLeft + 0.01f);
  if (cfg.cropBottom <= cfg.cropTop) cfg.cropBottom = std::min(1.0f, cfg.cropTop + 0.01f);
  return cfg;
}

static float medianDepth(const float* depth, int width, int height) {
  std::vector<float> samples;
  samples.reserve((width / 8) * (height / 8));
  for (int y = height / 6; y < height - height / 6; y += 8) {
    for (int x = width / 6; x < width - width / 6; x += 8) {
      const float d = depth[y * width + x];
      if (std::isfinite(d) && d > 500.0f && d < 8000.0f) samples.push_back(d);
    }
  }
  if (samples.empty()) return 0.0f;
  const size_t mid = samples.size() / 2;
  std::nth_element(samples.begin(), samples.begin() + mid, samples.end());
  return samples[mid];
}

static float clamp01(float value) {
  return std::max(0.0f, std::min(1.0f, value));
}

static void writeDepthPpm(const std::string& path, const float* depth, int width, int height) {
  std::ofstream out(path, std::ios::binary);
  if (!out) throw std::runtime_error("failed to open depth dump: " + path);
  out << "P6\n" << width << " " << height << "\n255\n";
  for (int idx = 0; idx < width * height; ++idx) {
    const float d = depth[idx];
    unsigned char rgb[3] = {10, 20, 35};
    if (std::isfinite(d) && d > 300.0f && d < 8000.0f) {
      const float t = std::max(0.0f, std::min(1.0f, (d - 500.0f) / 3500.0f));
      const unsigned char nearValue = static_cast<unsigned char>(255.0f - t * 210.0f);
      rgb[0] = nearValue;
      rgb[1] = static_cast<unsigned char>(std::max(0.0f, nearValue * 0.92f));
      rgb[2] = static_cast<unsigned char>(std::max(0.0f, nearValue * 0.65f));
    }
    out.write(reinterpret_cast<const char*>(rgb), 3);
  }
}

static DetectionStats collectStats(
  const float* depth,
  int width,
  int height,
  float wallMm,
  const std::vector<float>* background,
  const Config& cfg
) {
  DetectionStats stats;
  const int stride = cfg.stride;
  const int sw = width / stride;
  const int sh = height / stride;
  for (int sy = 0; sy < sh; ++sy) {
    for (int sx = 0; sx < sw; ++sx) {
      const int x = sx * stride;
      const int y = sy * stride;
      const float nx = (static_cast<float>(x) + 0.5f) / static_cast<float>(std::max(1, width));
      const float ny = (static_cast<float>(y) + 0.5f) / static_cast<float>(std::max(1, height));
      if (nx < cfg.cropLeft || nx > cfg.cropRight || ny < cfg.cropTop || ny > cfg.cropBottom) {
        continue;
      }
      const int depthIdx = y * width + x;
      const float d = depth[depthIdx];
      float referenceMm = wallMm;
      if (background != nullptr && depthIdx < static_cast<int>(background->size())) {
        const float bg = (*background)[depthIdx];
        if (std::isfinite(bg) && bg > 0.0f) referenceMm = bg;
      }
      if (!std::isfinite(d) || d <= 0.0f || referenceMm <= 0.0f) continue;
      stats.validSamples += 1;
      const float delta = referenceMm - d;
      if (delta > 0.0f) {
        stats.foregroundSamples += 1;
        stats.maxDeltaMm = std::max(stats.maxDeltaMm, delta);
      }
      if (delta > cfg.nearMinMm && delta < cfg.nearMaxMm) stats.candidateSamples += 1;
    }
  }
  return stats;
}

static std::vector<Hand> extractHands(
  const float* depth,
  int width,
  int height,
  float wallMm,
  const std::vector<float>* background,
  const Config& cfg
) {
  const int stride = cfg.stride;
  const int sw = width / stride;
  const int sh = height / stride;
  std::vector<unsigned char> mask(sw * sh, 0);
  for (int sy = 0; sy < sh; ++sy) {
    for (int sx = 0; sx < sw; ++sx) {
      const int x = sx * stride;
      const int y = sy * stride;
      const float nx = (static_cast<float>(x) + 0.5f) / static_cast<float>(std::max(1, width));
      const float ny = (static_cast<float>(y) + 0.5f) / static_cast<float>(std::max(1, height));
      if (nx < cfg.cropLeft || nx > cfg.cropRight || ny < cfg.cropTop || ny > cfg.cropBottom) {
        continue;
      }
      const int depthIdx = y * width + x;
      const float d = depth[depthIdx];
      float referenceMm = wallMm;
      if (background != nullptr && depthIdx < static_cast<int>(background->size())) {
        const float bg = (*background)[depthIdx];
        if (std::isfinite(bg) && bg > 0.0f) referenceMm = bg;
      }
      const bool valid = std::isfinite(d) && d > 0.0f;
      const bool inBand = valid && referenceMm > 0.0f && d < (referenceMm - cfg.nearMinMm) &&
                          d > (referenceMm - cfg.nearMaxMm);
      mask[sy * sw + sx] = inBand ? 1 : 0;
    }
  }

  std::vector<unsigned char> seen(sw * sh, 0);
  std::vector<Hand> components;
  const int offsets[8][2] = {{-1, -1}, {0, -1}, {1, -1}, {-1, 0}, {1, 0}, {-1, 1}, {0, 1}, {1, 1}};

  for (int sy = 0; sy < sh; ++sy) {
    for (int sx = 0; sx < sw; ++sx) {
      const int start = sy * sw + sx;
      if (!mask[start] || seen[start]) continue;
      std::queue<std::pair<int, int>> q;
      q.push({sx, sy});
      seen[start] = 1;
      int count = 0;
      int minSx = sx;
      int maxSx = sx;
      int minSy = sy;
      int maxSy = sy;
      double sumX = 0.0;
      double sumY = 0.0;
      while (!q.empty()) {
        const auto [x, y] = q.front();
        q.pop();
        count += 1;
        minSx = std::min(minSx, x);
        maxSx = std::max(maxSx, x);
        minSy = std::min(minSy, y);
        maxSy = std::max(maxSy, y);
        sumX += x;
        sumY += y;
        for (const auto& off : offsets) {
          const int nx = x + off[0];
          const int ny = y + off[1];
          if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) continue;
          const int idx = ny * sw + nx;
          if (!mask[idx] || seen[idx]) continue;
          seen[idx] = 1;
          q.push({nx, ny});
        }
      }
      if (count < cfg.minPixels) continue;
      Hand h;
      h.present = true;
      const float rawX = static_cast<float>((sumX / count + 0.5) / std::max(1, sw));
      const float rawY = static_cast<float>((sumY / count + 0.5) / std::max(1, sh));
      const float cropW = std::max(0.001f, cfg.cropRight - cfg.cropLeft);
      const float cropH = std::max(0.001f, cfg.cropBottom - cfg.cropTop);
      h.rawX = clamp01(rawX);
      h.rawY = clamp01(rawY);
      h.x = clamp01((rawX - cfg.cropLeft) / cropW);
      h.y = clamp01((rawY - cfg.cropTop) / cropH);
      h.size = std::min(1.0f, static_cast<float>(count * stride * stride) / static_cast<float>(width * height));
      h.count = count;
      if (h.size < cfg.minSize || h.size > cfg.maxSize) continue;
      const float rawMinX = static_cast<float>((minSx + 0.5) / std::max(1, sw));
      const float rawMaxX = static_cast<float>((maxSx + 0.5) / std::max(1, sw));
      const float rawMinY = static_cast<float>((minSy + 0.5) / std::max(1, sh));
      const float rawMaxY = static_cast<float>((maxSy + 0.5) / std::max(1, sh));
      h.minX = clamp01((rawMinX - cfg.cropLeft) / cropW);
      h.maxX = clamp01((rawMaxX - cfg.cropLeft) / cropW);
      h.minY = clamp01((rawMinY - cfg.cropTop) / cropH);
      h.maxY = clamp01((rawMaxY - cfg.cropTop) / cropH);
      h.centerX = (h.minX + h.maxX) * 0.5f;
      h.centerY = (h.minY + h.maxY) * 0.5f;
      h.width = std::max(0.0f, h.maxX - h.minX);
      h.height = std::max(0.0f, h.maxY - h.minY);
      if (h.width > cfg.maxWidth || h.height > cfg.maxHeight) continue;
      const float spanScore = clamp01((std::max(h.width, h.height) - 0.07f) / 0.16f);
      const float sizeScore = clamp01((h.size - 0.035f) / 0.12f);
      h.openScore = std::max(spanScore, sizeScore);
      components.push_back(h);
    }
  }

  std::sort(components.begin(), components.end(), [](const Hand& a, const Hand& b) {
    return a.count > b.count;
  });
  if (components.size() > 2) components.resize(2);
  std::sort(components.begin(), components.end(), [](const Hand& a, const Hand& b) {
    return a.x < b.x;
  });
  return components;
}

static void emitHand(const char* name, const Hand& hand, bool trailingComma) {
  std::cout << "\"" << name << "\":{\"present\":" << (hand.present ? 1 : 0)
            << ",\"x\":" << hand.x
            << ",\"y\":" << hand.y
            << ",\"raw_x\":" << hand.rawX
            << ",\"raw_y\":" << hand.rawY
            << ",\"size\":" << hand.size
            << ",\"open_score\":" << hand.openScore
            << ",\"min_x\":" << hand.minX
            << ",\"min_y\":" << hand.minY
            << ",\"max_x\":" << hand.maxX
            << ",\"max_y\":" << hand.maxY
            << ",\"center_x\":" << hand.centerX
            << ",\"center_y\":" << hand.centerY
            << ",\"width\":" << hand.width
            << ",\"height\":" << hand.height
            << ",\"count\":" << hand.count
            << "}";
  if (trailingComma) std::cout << ",";
}

static void emitJson(const std::vector<Hand>& hands) {
  const Hand empty;
  const Hand& left = hands.size() >= 1 ? hands[0] : empty;
  const Hand& right = hands.size() >= 2 ? hands[1] : empty;
  std::cout << "{";
  emitHand("left", left, true);
  emitHand("right", right, false);
  std::cout << "}" << std::endl;
}

int main(int argc, char** argv) {
  Config cfg;
  try {
    cfg = parseArgs(argc, argv);
  } catch (const std::exception& exc) {
    std::cerr << "[kinect-depth-bridge] " << exc.what() << std::endl;
    return 2;
  }

  libfreenect2::setGlobalLogger(libfreenect2::createConsoleLogger(libfreenect2::Logger::Warning));
  libfreenect2::Freenect2 freenect2;
  if (freenect2.enumerateDevices() == 0) {
    std::cerr << "[kinect-depth-bridge] no Kinect v2 device found" << std::endl;
    return 3;
  }

  const std::string serial = freenect2.getDefaultDeviceSerialNumber();
  libfreenect2::PacketPipeline* pipeline = new libfreenect2::CpuPacketPipeline();
  libfreenect2::Freenect2Device* dev = freenect2.openDevice(serial, pipeline);
  if (dev == nullptr) {
    std::cerr << "[kinect-depth-bridge] failed to open Kinect serial " << serial << std::endl;
    return 4;
  }

  libfreenect2::SyncMultiFrameListener listener(libfreenect2::Frame::Depth);
  dev->setIrAndDepthFrameListener(&listener);
  if (!dev->startStreams(false, true)) {
    std::cerr << "[kinect-depth-bridge] failed to start depth stream" << std::endl;
    dev->close();
    return 5;
  }
  std::cerr << "[kinect-depth-bridge] opened serial " << serial << std::endl;

  libfreenect2::Registration registration(dev->getIrCameraParams(), dev->getColorCameraParams());
  libfreenect2::Frame undistorted(512, 424, 4);

  float wallMm = cfg.wallMm;
  int rawFrameCount = 0;
  int outputFrameCount = 0;
  int backgroundFrameCount = 0;
  std::vector<float> background;
  std::vector<float> backgroundSum;
  std::vector<int> backgroundCount;
  while (cfg.frames == 0 || outputFrameCount < cfg.frames) {
    libfreenect2::FrameMap frames;
    if (!listener.waitForNewFrame(frames, 10000)) {
      std::cerr << "[kinect-depth-bridge] timeout waiting for depth frame" << std::endl;
      break;
    }
    libfreenect2::Frame* depth = frames[libfreenect2::Frame::Depth];
    const int width = static_cast<int>(depth->width);
    const int height = static_cast<int>(depth->height);
    const float* data = reinterpret_cast<float*>(depth->data);
    if (cfg.undistortDepth) {
      registration.undistortDepth(depth, &undistorted);
      data = reinterpret_cast<float*>(undistorted.data);
    }
    const int pixelCount = width * height;

    if (!cfg.dumpDepthPpm.empty()) {
      try {
        writeDepthPpm(cfg.dumpDepthPpm, data, width, height);
        std::cerr << "[kinect-depth-bridge] wrote depth dump " << cfg.dumpDepthPpm << std::endl;
      } catch (const std::exception& exc) {
        std::cerr << "[kinect-depth-bridge] " << exc.what() << std::endl;
      }
      emitJson({});
      listener.release(frames);
      rawFrameCount += 1;
      break;
    }

    if (cfg.backgroundFrames > 0 && static_cast<int>(background.size()) != pixelCount) {
      background.assign(pixelCount, 0.0F);
      backgroundSum.assign(pixelCount, 0.0F);
      backgroundCount.assign(pixelCount, 0);
      backgroundFrameCount = 0;
    }

    if (cfg.backgroundFrames > 0 && backgroundFrameCount < cfg.backgroundFrames) {
      const float measured = medianDepth(data, width, height);
      if (cfg.wallMm <= 0.0F && measured > 0.0F) {
        wallMm = wallMm <= 0.0F ? measured : wallMm * 0.85F + measured * 0.15F;
      }
      for (int idx = 0; idx < pixelCount; ++idx) {
        const float d = data[idx];
        if (std::isfinite(d) && d > 300.0F && d < 8000.0F) {
          backgroundSum[idx] += d;
          backgroundCount[idx] += 1;
        }
      }
      backgroundFrameCount += 1;
      if (backgroundFrameCount == cfg.backgroundFrames) {
        int validPixels = 0;
        for (int idx = 0; idx < pixelCount; ++idx) {
          if (backgroundCount[idx] > 0) {
            background[idx] = backgroundSum[idx] / static_cast<float>(backgroundCount[idx]);
            validPixels += 1;
          }
        }
        std::cerr << "[kinect-depth-bridge] calibrated background_frames="
                  << backgroundFrameCount << " valid_pixels=" << validPixels
                  << " fallback_wall_mm=" << wallMm << std::endl;
      }
      emitJson({});
    } else if (cfg.wallMm <= 0.0F && rawFrameCount < cfg.calibrationFrames) {
      const float measured = medianDepth(data, width, height);
      if (measured > 0.0F) {
        wallMm = wallMm <= 0.0F ? measured : wallMm * 0.85F + measured * 0.15F;
      }
      if (rawFrameCount == cfg.calibrationFrames - 1) {
        std::cerr << "[kinect-depth-bridge] calibrated wall_mm=" << wallMm << std::endl;
      }
      emitJson({});
    } else if (wallMm > 0.0F) {
      const std::vector<float>* backgroundPtr = cfg.backgroundFrames > 0 ? &background : nullptr;
      std::vector<Hand> hands = extractHands(
        data,
        width,
        height,
        wallMm,
        backgroundPtr,
        cfg
      );
      if (cfg.debugEvery > 0 && rawFrameCount % cfg.debugEvery == 0) {
        const DetectionStats stats = collectStats(data, width, height, wallMm, backgroundPtr, cfg);
        std::cerr << "[kinect-depth-bridge] debug frame=" << rawFrameCount
                  << " valid=" << stats.validSamples
                  << " foreground=" << stats.foregroundSamples
                  << " candidates=" << stats.candidateSamples
                  << " max_delta_mm=" << stats.maxDeltaMm
                  << " hands=" << hands.size() << std::endl;
      }
      emitJson(hands);
      outputFrameCount += 1;
    } else {
      emitJson({});
      outputFrameCount += 1;
    }

    listener.release(frames);
    rawFrameCount += 1;
  }

  dev->stop();
  dev->close();
  return 0;
}

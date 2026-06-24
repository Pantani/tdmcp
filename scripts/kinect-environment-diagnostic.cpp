#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/logger.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/registration.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct Config {
  int frames = 0;
  int width = 1280;
  int height = 720;
  int backgroundFrames = 60;
  int rate = 6;
  float nearMinMm = 15.0f;
  float nearMaxMm = 220.0f;
  std::string rawPath = "/tmp/kinect_environment_diagnostic.rgba";
  std::string jsonPath = "/tmp/kinect_environment_diagnostic.json";
};

struct Stats {
  int samples = 0;
  int validDepth = 0;
  int foreground = 0;
  int candidates = 0;
  int projectionSamples = 0;
  int foregroundInProjection = 0;
  int candidatesInProjection = 0;
  float maxDeltaMm = 0.0f;
  float medianWallMm = 0.0f;
  double candidateProjectionSumX = 0.0;
  double candidateProjectionSumY = 0.0;
};

struct MarkerStats {
  int samples = 0;
  double sumX = 0.0;
  double sumY = 0.0;
};

struct RgbAnalysis {
  int sampleCount = 0;
  int brightSamples = 0;
  int minX = 0;
  int minY = 0;
  int maxX = 0;
  int maxY = 0;
  bool projectionPresent = false;
  MarkerStats red;
  MarkerStats green;
  MarkerStats blue;
  MarkerStats yellow;
  MarkerStats cyan;
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
    } else if (arg == "--width") {
      if (!readIntArg(argc, argv, i, cfg.width)) throw std::runtime_error("missing --width value");
    } else if (arg == "--height") {
      if (!readIntArg(argc, argv, i, cfg.height)) throw std::runtime_error("missing --height value");
    } else if (arg == "--rate") {
      if (!readIntArg(argc, argv, i, cfg.rate)) throw std::runtime_error("missing --rate value");
    } else if (arg == "--background-frames") {
      if (!readIntArg(argc, argv, i, cfg.backgroundFrames)) {
        throw std::runtime_error("missing --background-frames value");
      }
    } else if (arg == "--near-min-mm") {
      if (!readFloatArg(argc, argv, i, cfg.nearMinMm)) {
        throw std::runtime_error("missing --near-min-mm value");
      }
    } else if (arg == "--near-max-mm") {
      if (!readFloatArg(argc, argv, i, cfg.nearMaxMm)) {
        throw std::runtime_error("missing --near-max-mm value");
      }
    } else if (arg == "--raw") {
      if (i + 1 >= argc) throw std::runtime_error("missing --raw value");
      cfg.rawPath = argv[++i];
    } else if (arg == "--json") {
      if (i + 1 >= argc) throw std::runtime_error("missing --json value");
      cfg.jsonPath = argv[++i];
    } else if (arg == "--help" || arg == "-h") {
      std::cout << "Usage: kinect-environment-diagnostic [--frames n] [--width n] [--height n]"
                << " [--rate hz] [--background-frames n] [--near-min-mm mm]"
                << " [--near-max-mm mm] [--raw path] [--json path]\n";
      std::exit(0);
    } else {
      throw std::runtime_error("unknown argument: " + arg);
    }
  }
  cfg.width = std::max(320, cfg.width);
  cfg.height = std::max(240, cfg.height);
  cfg.backgroundFrames = std::max(0, cfg.backgroundFrames);
  cfg.rate = std::max(1, cfg.rate);
  cfg.nearMinMm = std::max(1.0f, cfg.nearMinMm);
  cfg.nearMaxMm = std::max(cfg.nearMinMm + 1.0f, cfg.nearMaxMm);
  return cfg;
}

static void setPixel(std::vector<unsigned char>& img, int width, int height, int x, int y, unsigned char r, unsigned char g, unsigned char b) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const int idx = (y * width + x) * 4;
  img[idx + 0] = r;
  img[idx + 1] = g;
  img[idx + 2] = b;
  img[idx + 3] = 255;
}

static void fillRect(std::vector<unsigned char>& img, int width, int height, int x0, int y0, int x1, int y1, unsigned char r, unsigned char g, unsigned char b) {
  x0 = std::max(0, std::min(width, x0));
  x1 = std::max(0, std::min(width, x1));
  y0 = std::max(0, std::min(height, y0));
  y1 = std::max(0, std::min(height, y1));
  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) setPixel(img, width, height, x, y, r, g, b);
  }
}

static void drawBorder(std::vector<unsigned char>& img, int width, int height, int x0, int y0, int x1, int y1, unsigned char r, unsigned char g, unsigned char b) {
  for (int x = x0; x < x1; ++x) {
    setPixel(img, width, height, x, y0, r, g, b);
    setPixel(img, width, height, x, y1 - 1, r, g, b);
  }
  for (int y = y0; y < y1; ++y) {
    setPixel(img, width, height, x0, y, r, g, b);
    setPixel(img, width, height, x1 - 1, y, r, g, b);
  }
}

static void drawBox(std::vector<unsigned char>& img, int width, int height, int x0, int y0, int x1, int y1, unsigned char r, unsigned char g, unsigned char b) {
  for (int i = 0; i < 3; ++i) drawBorder(img, width, height, x0 + i, y0 + i, x1 - i, y1 - i, r, g, b);
}

static void drawCross(std::vector<unsigned char>& img, int width, int height, int cx, int cy, unsigned char r, unsigned char g, unsigned char b) {
  for (int d = -16; d <= 16; ++d) {
    for (int t = -2; t <= 2; ++t) {
      setPixel(img, width, height, cx + d, cy + t, r, g, b);
      setPixel(img, width, height, cx + t, cy + d, r, g, b);
    }
  }
}

static float medianDepth(const float* depth, int width, int height) {
  std::vector<float> samples;
  samples.reserve((width / 8) * (height / 8));
  for (int y = height / 6; y < height - height / 6; y += 8) {
    for (int x = width / 6; x < width - width / 6; x += 8) {
      const float d = depth[y * width + x];
      if (std::isfinite(d) && d > 300.0f && d < 8000.0f) samples.push_back(d);
    }
  }
  if (samples.empty()) return 0.0f;
  const size_t mid = samples.size() / 2;
  std::nth_element(samples.begin(), samples.begin() + mid, samples.end());
  return samples[mid];
}

static void addMarker(MarkerStats& marker, int x, int y) {
  marker.samples += 1;
  marker.sumX += x;
  marker.sumY += y;
}

static RgbAnalysis analyzeRgb(const libfreenect2::Frame* color) {
  RgbAnalysis analysis;
  const int width = static_cast<int>(color->width);
  const int height = static_cast<int>(color->height);
  const unsigned char* src = reinterpret_cast<const unsigned char*>(color->data);
  analysis.minX = width;
  analysis.minY = height;
  const int stride = 2;
  for (int y = 0; y < height; y += stride) {
    for (int x = 0; x < width; x += stride) {
      const int idx = (y * width + x) * 4;
      const int b = src[idx + 0];
      const int g = src[idx + 1];
      const int r = src[idx + 2];
      analysis.sampleCount += 1;
      const float luma = 0.2126f * static_cast<float>(r) + 0.7152f * static_cast<float>(g) + 0.0722f * static_cast<float>(b);
      if (luma > 235.0f) {
        analysis.brightSamples += 1;
        analysis.minX = std::min(analysis.minX, x);
        analysis.minY = std::min(analysis.minY, y);
        analysis.maxX = std::max(analysis.maxX, x);
        analysis.maxY = std::max(analysis.maxY, y);
      }
    }
  }
  analysis.projectionPresent = analysis.brightSamples > 200;
  if (!analysis.projectionPresent) {
    analysis.minX = 0;
    analysis.minY = 0;
    analysis.maxX = 0;
    analysis.maxY = 0;
    return analysis;
  }
  const int insetX = std::max(2, (analysis.maxX - analysis.minX) / 100);
  const int insetY = std::max(2, (analysis.maxY - analysis.minY) / 100);
  for (int y = analysis.minY + insetY; y <= analysis.maxY - insetY; y += stride) {
    for (int x = analysis.minX + insetX; x <= analysis.maxX - insetX; x += stride) {
      const int idx = (y * width + x) * 4;
      const int b = src[idx + 0];
      const int g = src[idx + 1];
      const int r = src[idx + 2];
      if (r > 150 && r > g + 25 && r > b + 25) addMarker(analysis.red, x, y);
      if (g > 120 && g > r * 1.25f && g > b * 1.25f) addMarker(analysis.green, x, y);
      if (b > 115 && b > r * 1.2f && b > g * 1.1f) addMarker(analysis.blue, x, y);
      if (r > 145 && g > 125 && b < 125 && std::abs(r - g) < 90) addMarker(analysis.yellow, x, y);
      if (g > 120 && b > 120 && r < 120 && std::abs(g - b) < 100) addMarker(analysis.cyan, x, y);
    }
  }
  return analysis;
}

static void drawRgbOverlay(
  std::vector<unsigned char>& img,
  int outW,
  int outH,
  int x0,
  int y0,
  int x1,
  int y1,
  const libfreenect2::Frame* color,
  const RgbAnalysis& analysis
) {
  const float sx = static_cast<float>(x1 - x0) / static_cast<float>(std::max(1, static_cast<int>(color->width)));
  const float sy = static_cast<float>(y1 - y0) / static_cast<float>(std::max(1, static_cast<int>(color->height)));
  if (analysis.projectionPresent) {
    drawBox(
      img,
      outW,
      outH,
      x0 + static_cast<int>(analysis.minX * sx),
      y0 + static_cast<int>(analysis.minY * sy),
      x0 + static_cast<int>(analysis.maxX * sx),
      y0 + static_cast<int>(analysis.maxY * sy),
      255,
      0,
      255
    );
  }
  const auto drawMarker = [&](const MarkerStats& marker, unsigned char r, unsigned char g, unsigned char b) {
    if (marker.samples < 20) return;
    const int cx = x0 + static_cast<int>((marker.sumX / marker.samples) * sx);
    const int cy = y0 + static_cast<int>((marker.sumY / marker.samples) * sy);
    drawCross(img, outW, outH, cx, cy, r, g, b);
  };
  drawMarker(analysis.red, 255, 40, 40);
  drawMarker(analysis.green, 0, 230, 90);
  drawMarker(analysis.blue, 60, 120, 255);
  drawMarker(analysis.yellow, 255, 215, 0);
  drawMarker(analysis.cyan, 0, 220, 255);
}

static void drawAnalysisBox(
  std::vector<unsigned char>& img,
  int outW,
  int outH,
  int x0,
  int y0,
  int x1,
  int y1,
  const RgbAnalysis& analysis,
  unsigned char r,
  unsigned char g,
  unsigned char b
) {
  if (!analysis.projectionPresent) return;
  const int sourceW = std::max(1, analysis.maxX >= analysis.minX ? analysis.maxX + 1 : 1);
  const int sourceH = std::max(1, analysis.maxY >= analysis.minY ? analysis.maxY + 1 : 1);
  (void)sourceW;
  (void)sourceH;
  const float sx = static_cast<float>(x1 - x0) / 512.0f;
  const float sy = static_cast<float>(y1 - y0) / 424.0f;
  drawBox(
    img,
    outW,
    outH,
    x0 + static_cast<int>(analysis.minX * sx),
    y0 + static_cast<int>(analysis.minY * sy),
    x0 + static_cast<int>(analysis.maxX * sx),
    y0 + static_cast<int>(analysis.maxY * sy),
    r,
    g,
    b
  );
}

static void depthColor(float d, unsigned char& r, unsigned char& g, unsigned char& b) {
  if (!std::isfinite(d) || d <= 0.0f) {
    r = 8;
    g = 10;
    b = 14;
    return;
  }
  const float t = std::max(0.0f, std::min(1.0f, (d - 500.0f) / 3500.0f));
  r = static_cast<unsigned char>(255.0f * (1.0f - t));
  g = static_cast<unsigned char>(90.0f + 120.0f * (1.0f - std::abs(t - 0.5f) * 2.0f));
  b = static_cast<unsigned char>(255.0f * t);
}

static void drawColorPanel(std::vector<unsigned char>& img, const libfreenect2::Frame* color, int outW, int outH, int x0, int y0, int x1, int y1) {
  const int panelW = std::max(1, x1 - x0);
  const int panelH = std::max(1, y1 - y0);
  const unsigned char* src = reinterpret_cast<const unsigned char*>(color->data);
  for (int y = 0; y < panelH; ++y) {
    const int sy = std::min(static_cast<int>(color->height) - 1, y * static_cast<int>(color->height) / panelH);
    for (int x = 0; x < panelW; ++x) {
      const int sx = std::min(static_cast<int>(color->width) - 1, x * static_cast<int>(color->width) / panelW);
      const int idx = (sy * static_cast<int>(color->width) + sx) * 4;
      setPixel(img, outW, outH, x0 + x, y0 + y, src[idx + 2], src[idx + 1], src[idx + 0]);
    }
  }
}

static void drawDepthPanel(std::vector<unsigned char>& img, const float* depth, int dw, int dh, int outW, int outH, int x0, int y0, int x1, int y1) {
  const int panelW = std::max(1, x1 - x0);
  const int panelH = std::max(1, y1 - y0);
  for (int y = 0; y < panelH; ++y) {
    const int sy = std::min(dh - 1, y * dh / panelH);
    for (int x = 0; x < panelW; ++x) {
      const int sx = std::min(dw - 1, x * dw / panelW);
      unsigned char r, g, b;
      depthColor(depth[sy * dw + sx], r, g, b);
      setPixel(img, outW, outH, x0 + x, y0 + y, r, g, b);
    }
  }
}

static void drawIrPanel(std::vector<unsigned char>& img, const float* ir, int iw, int ih, int outW, int outH, int x0, int y0, int x1, int y1) {
  const int panelW = std::max(1, x1 - x0);
  const int panelH = std::max(1, y1 - y0);
  for (int y = 0; y < panelH; ++y) {
    const int sy = std::min(ih - 1, y * ih / panelH);
    for (int x = 0; x < panelW; ++x) {
      const int sx = std::min(iw - 1, x * iw / panelW);
      const float v = ir[sy * iw + sx];
      const float t = std::isfinite(v) ? std::max(0.0f, std::min(1.0f, std::log1p(v) / std::log1p(65535.0f))) : 0.0f;
      const unsigned char c = static_cast<unsigned char>(255.0f * t);
      setPixel(img, outW, outH, x0 + x, y0 + y, c, c, static_cast<unsigned char>(std::max(0.0f, c * 0.82f)));
    }
  }
}

static Stats drawMaskPanel(
  std::vector<unsigned char>& img,
  const float* depth,
  int dw,
  int dh,
  const std::vector<float>& background,
  bool backgroundReady,
  const Config& cfg,
  const RgbAnalysis& registeredProjection,
  int x0,
  int y0,
  int x1,
  int y1
) {
  Stats stats;
  stats.medianWallMm = medianDepth(depth, dw, dh);
  const int panelW = std::max(1, x1 - x0);
  const int panelH = std::max(1, y1 - y0);
  for (int y = 0; y < panelH; ++y) {
    const int sy = std::min(dh - 1, y * dh / panelH);
    for (int x = 0; x < panelW; ++x) {
      const int sx = std::min(dw - 1, x * dw / panelW);
      const int idx = sy * dw + sx;
      const float d = depth[idx];
      stats.samples += 1;
      if (std::isfinite(d) && d > 0.0f) stats.validDepth += 1;
      const bool inProjection =
        registeredProjection.projectionPresent &&
        sx >= registeredProjection.minX &&
        sx <= registeredProjection.maxX &&
        sy >= registeredProjection.minY &&
        sy <= registeredProjection.maxY;
      if (inProjection) stats.projectionSamples += 1;
      unsigned char r = 24, g = 26, b = 30;
      if (inProjection) {
        r = 22;
        g = 42;
        b = 32;
      }
      if (backgroundReady && idx < static_cast<int>(background.size()) && std::isfinite(d) && d > 0.0f && background[idx] > 0.0f) {
        const float delta = background[idx] - d;
        if (delta > 0.0f) {
          stats.foreground += 1;
          if (inProjection) stats.foregroundInProjection += 1;
          stats.maxDeltaMm = std::max(stats.maxDeltaMm, delta);
          r = 35;
          g = 70;
          b = 110;
          if (inProjection) {
            r = 35;
            g = 98;
            b = 75;
          }
        }
        if (delta >= cfg.nearMinMm && delta <= cfg.nearMaxMm) {
          stats.candidates += 1;
          if (inProjection) {
            stats.candidatesInProjection += 1;
            stats.candidateProjectionSumX += static_cast<double>(sx) / std::max(1, dw);
            stats.candidateProjectionSumY += static_cast<double>(sy) / std::max(1, dh);
            r = 0;
            g = 235;
            b = 145;
          } else {
            r = 255;
            g = 176;
            b = 0;
          }
        }
      }
      setPixel(img, cfg.width, cfg.height, x0 + x, y0 + y, r, g, b);
    }
  }
  return stats;
}

static void writeAtomic(const std::string& path, const char* data, size_t bytes) {
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary);
    if (!out) throw std::runtime_error("failed to open " + tmp);
    out.write(data, static_cast<std::streamsize>(bytes));
  }
  std::rename(tmp.c_str(), path.c_str());
}

static void writeMarkerJson(std::ostringstream& out, const char* name, const MarkerStats& marker, int width, int height) {
  const bool present = marker.samples >= 20;
  out << "\"" << name << "\":{"
      << "\"present\":" << (present ? "true" : "false") << ","
      << "\"samples\":" << marker.samples << ","
      << "\"x\":" << (present ? marker.sumX / marker.samples / std::max(1, width) : 0.0) << ","
      << "\"y\":" << (present ? marker.sumY / marker.samples / std::max(1, height) : 0.0)
      << "}";
}

static void writeJson(
  const Config& cfg,
  const std::string& serial,
  int frame,
  bool backgroundReady,
  int backgroundCount,
  const Stats& stats,
  const RgbAnalysis& rgb,
  const RgbAnalysis& registeredProjection,
  int cw,
  int ch,
  int dw,
  int dh
) {
  std::ostringstream out;
  const int depthSamples = std::max(1, stats.samples);
  const int colorSamples = std::max(1, rgb.sampleCount);
  out << "{"
      << "\"ok\":true,"
      << "\"serial\":\"" << serial << "\","
      << "\"frame\":" << frame << ","
      << "\"background_ready\":" << (backgroundReady ? "true" : "false") << ","
      << "\"background_frames\":" << backgroundCount << ","
      << "\"color_width\":" << cw << ","
      << "\"color_height\":" << ch << ","
      << "\"depth_width\":" << dw << ","
      << "\"depth_height\":" << dh << ","
      << "\"ir_width\":" << dw << ","
      << "\"ir_height\":" << dh << ","
      << "\"projection_present\":" << (rgb.projectionPresent ? "true" : "false") << ","
      << "\"projection_bright_ratio\":" << (static_cast<double>(rgb.brightSamples) / static_cast<double>(colorSamples)) << ","
      << "\"projection_bbox\":{"
      << "\"x0\":" << (rgb.projectionPresent ? static_cast<double>(rgb.minX) / std::max(1, cw) : 0.0) << ","
      << "\"y0\":" << (rgb.projectionPresent ? static_cast<double>(rgb.minY) / std::max(1, ch) : 0.0) << ","
      << "\"x1\":" << (rgb.projectionPresent ? static_cast<double>(rgb.maxX) / std::max(1, cw) : 0.0) << ","
      << "\"y1\":" << (rgb.projectionPresent ? static_cast<double>(rgb.maxY) / std::max(1, ch) : 0.0)
      << "},"
      << "\"registered_projection_present\":" << (registeredProjection.projectionPresent ? "true" : "false") << ","
      << "\"registered_projection_bright_ratio\":"
      << (static_cast<double>(registeredProjection.brightSamples) / static_cast<double>(std::max(1, registeredProjection.sampleCount))) << ","
      << "\"registered_projection_bbox\":{"
      << "\"x0\":" << (registeredProjection.projectionPresent ? static_cast<double>(registeredProjection.minX) / std::max(1, dw) : 0.0) << ","
      << "\"y0\":" << (registeredProjection.projectionPresent ? static_cast<double>(registeredProjection.minY) / std::max(1, dh) : 0.0) << ","
      << "\"x1\":" << (registeredProjection.projectionPresent ? static_cast<double>(registeredProjection.maxX) / std::max(1, dw) : 0.0) << ","
      << "\"y1\":" << (registeredProjection.projectionPresent ? static_cast<double>(registeredProjection.maxY) / std::max(1, dh) : 0.0)
      << "},";
  writeMarkerJson(out, "marker_red", rgb.red, cw, ch);
  out << ",";
  writeMarkerJson(out, "marker_green", rgb.green, cw, ch);
  out << ",";
  writeMarkerJson(out, "marker_blue", rgb.blue, cw, ch);
  out << ",";
  writeMarkerJson(out, "marker_yellow", rgb.yellow, cw, ch);
  out << ",";
  writeMarkerJson(out, "marker_cyan", rgb.cyan, cw, ch);
  out << ","
      << "\"valid_depth_ratio\":" << (static_cast<double>(stats.validDepth) / static_cast<double>(depthSamples)) << ","
      << "\"foreground_samples\":" << stats.foreground << ","
      << "\"candidate_samples\":" << stats.candidates << ","
      << "\"projection_depth_samples\":" << stats.projectionSamples << ","
      << "\"foreground_samples_in_projection\":" << stats.foregroundInProjection << ","
      << "\"candidate_samples_in_projection\":" << stats.candidatesInProjection << ","
      << "\"candidate_projection_x\":"
      << (stats.candidatesInProjection > 0 ? stats.candidateProjectionSumX / stats.candidatesInProjection : 0.0) << ","
      << "\"candidate_projection_y\":"
      << (stats.candidatesInProjection > 0 ? stats.candidateProjectionSumY / stats.candidatesInProjection : 0.0) << ","
      << "\"max_delta_mm\":" << stats.maxDeltaMm << ","
      << "\"median_wall_mm\":" << stats.medianWallMm << ","
      << "\"near_min_mm\":" << cfg.nearMinMm << ","
      << "\"near_max_mm\":" << cfg.nearMaxMm << ","
      << "\"raw_width\":" << cfg.width << ","
      << "\"raw_height\":" << cfg.height
      << "}\n";
  const std::string json = out.str();
  writeAtomic(cfg.jsonPath, json.data(), json.size());
}

int main(int argc, char** argv) {
  Config cfg;
  try {
    cfg = parseArgs(argc, argv);
  } catch (const std::exception& exc) {
    std::cerr << "[kinect-environment-diagnostic] " << exc.what() << std::endl;
    return 2;
  }

  libfreenect2::setGlobalLogger(libfreenect2::createConsoleLogger(libfreenect2::Logger::Warning));
  libfreenect2::Freenect2 freenect2;
  if (freenect2.enumerateDevices() == 0) {
    std::cerr << "[kinect-environment-diagnostic] no Kinect v2 device found" << std::endl;
    return 3;
  }

  const std::string serial = freenect2.getDefaultDeviceSerialNumber();
  libfreenect2::PacketPipeline* pipeline = new libfreenect2::CpuPacketPipeline();
  libfreenect2::Freenect2Device* dev = freenect2.openDevice(serial, pipeline);
  if (dev == nullptr) {
    std::cerr << "[kinect-environment-diagnostic] failed to open Kinect serial " << serial << std::endl;
    return 4;
  }

  const int frameTypes = libfreenect2::Frame::Color | libfreenect2::Frame::Ir | libfreenect2::Frame::Depth;
  libfreenect2::SyncMultiFrameListener listener(frameTypes);
  dev->setColorFrameListener(&listener);
  dev->setIrAndDepthFrameListener(&listener);
  if (!dev->start()) {
    std::cerr << "[kinect-environment-diagnostic] failed to start color/depth/ir stream" << std::endl;
    dev->close();
    return 5;
  }
  std::cerr << "[kinect-environment-diagnostic] opened serial " << serial << std::endl;

  libfreenect2::Registration registration(dev->getIrCameraParams(), dev->getColorCameraParams());
  libfreenect2::Frame undistorted(512, 424, 4);
  libfreenect2::Frame registered(512, 424, 4);

  int frame = 0;
  int backgroundCount = 0;
  std::vector<float> background;
  std::vector<float> backgroundSum;
  std::vector<int> backgroundN;
  while (cfg.frames == 0 || frame < cfg.frames) {
    libfreenect2::FrameMap frames;
    if (!listener.waitForNewFrame(frames, 10000)) {
      std::cerr << "[kinect-environment-diagnostic] timeout waiting for frame" << std::endl;
      break;
    }
    libfreenect2::Frame* color = frames[libfreenect2::Frame::Color];
    libfreenect2::Frame* ir = frames[libfreenect2::Frame::Ir];
    libfreenect2::Frame* depth = frames[libfreenect2::Frame::Depth];
    registration.apply(color, depth, &undistorted, &registered, false);
    const int dw = static_cast<int>(depth->width);
    const int dh = static_cast<int>(depth->height);
    const int pixelCount = dw * dh;
    const float* depthData = reinterpret_cast<float*>(depth->data);
    const float* registeredDepthData = reinterpret_cast<float*>(undistorted.data);
    const float* irData = reinterpret_cast<float*>(ir->data);

    if (static_cast<int>(background.size()) != pixelCount) {
      background.assign(pixelCount, 0.0f);
      backgroundSum.assign(pixelCount, 0.0f);
      backgroundN.assign(pixelCount, 0);
      backgroundCount = 0;
    }

    if (backgroundCount < cfg.backgroundFrames) {
      for (int idx = 0; idx < pixelCount; ++idx) {
        const float d = registeredDepthData[idx];
        if (std::isfinite(d) && d > 300.0f && d < 8000.0f) {
          backgroundSum[idx] += d;
          backgroundN[idx] += 1;
        }
      }
      backgroundCount += 1;
      if (backgroundCount == cfg.backgroundFrames) {
        int valid = 0;
        for (int idx = 0; idx < pixelCount; ++idx) {
          if (backgroundN[idx] > 0) {
            background[idx] = backgroundSum[idx] / static_cast<float>(backgroundN[idx]);
            valid += 1;
          }
        }
        std::cerr << "[kinect-environment-diagnostic] calibrated background valid_pixels=" << valid << std::endl;
      }
    }

    std::vector<unsigned char> img(cfg.width * cfg.height * 4, 255);
    fillRect(img, cfg.width, cfg.height, 0, 0, cfg.width, cfg.height, 245, 245, 242);
    const int midX = cfg.width / 2;
    const int midY = cfg.height / 2;
    const RgbAnalysis rgb = analyzeRgb(color);
    const RgbAnalysis registeredRgb = analyzeRgb(&registered);
    drawColorPanel(img, color, cfg.width, cfg.height, 0, 0, midX, midY);
    drawRgbOverlay(img, cfg.width, cfg.height, 0, 0, midX, midY, color, rgb);
    drawDepthPanel(img, depthData, dw, dh, cfg.width, cfg.height, midX, 0, cfg.width, midY);
    drawIrPanel(img, irData, dw, dh, cfg.width, cfg.height, 0, midY, midX, cfg.height);
    const bool backgroundReady = backgroundCount >= cfg.backgroundFrames;
    Stats stats = drawMaskPanel(
      img,
      registeredDepthData,
      dw,
      dh,
      background,
      backgroundReady,
      cfg,
      registeredRgb,
      midX,
      midY,
      cfg.width,
      cfg.height
    );
    drawAnalysisBox(img, cfg.width, cfg.height, midX, midY, cfg.width, cfg.height, registeredRgb, 0, 245, 150);

    drawBorder(img, cfg.width, cfg.height, 0, 0, midX, midY, 0, 255, 255);
    drawBorder(img, cfg.width, cfg.height, midX, 0, cfg.width, midY, 255, 0, 120);
    drawBorder(img, cfg.width, cfg.height, 0, midY, midX, cfg.height, 255, 255, 0);
    drawBorder(img, cfg.width, cfg.height, midX, midY, cfg.width, cfg.height, 255, 176, 0);
    fillRect(img, cfg.width, cfg.height, 0, 0, cfg.width, 10, backgroundReady ? 0 : 255, backgroundReady ? 190 : 120, backgroundReady ? 80 : 0);
    if (stats.candidates > 0) {
      fillRect(img, cfg.width, cfg.height, cfg.width - 120, 0, cfg.width, 10, 255, 176, 0);
    }

    writeAtomic(cfg.rawPath, reinterpret_cast<const char*>(img.data()), img.size());
    writeJson(
      cfg,
      serial,
      frame,
      backgroundReady,
      backgroundCount,
      stats,
      rgb,
      registeredRgb,
      static_cast<int>(color->width),
      static_cast<int>(color->height),
      dw,
      dh
    );
    listener.release(frames);
    frame += 1;
    std::this_thread::sleep_for(std::chrono::milliseconds(std::max(1, 1000 / cfg.rate)));
  }

  dev->stop();
  dev->close();
  return 0;
}

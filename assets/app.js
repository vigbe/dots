/* ==========================================================================
   dots v2.1 — convertidor de imagen a ASCII art · vicbas.com/dots
   --------------------------------------------------------------------------
   Motor portado del monolito index.html v1 (la matemática de conversión y
   efectos se conserva intacta) y modernizado:

   - pixelsToAscii / computeFrame: conversión y los 11 efectos animados.
   - Corregido respecto a v1: pixelate emitía '\n' por bloque-columna
     (salida rota) y el embed animado no escapaba el charset (JS inválido
     con la densidad "ultra").
   - Nuevos: export SVG autocontenido, ANSI truecolor 24-bit, copiado con
     fallback para file://, carga por pegado (Ctrl+V), barra de estado.

   Script clásico (sin type="module"), con defer, para funcionar también
   abierto desde file://. Sin dependencias externas en runtime salvo la
   copia local de gif.js (assets/vendor/).
   ========================================================================== */

(() => {
  /* ------------------------------------------------------------------ */
  /* Constantes del motor (portadas de v1)                              */
  /* ------------------------------------------------------------------ */

  var DENSITY_SCALES = {
    ultra:
      "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"'. ",
    detailed: "N@#W$9876543210?!abc;:+=-,._ ",
    standard: " .:-=+*#%@",
    smooth: " ░▒▓█",
    minimal: " .:#@",
    binary: " @",
  };

  var COLORS = {
    purple: "#9D4EDD",
    cyan: "#00E5FF",
    green: "#00FF41",
    white: "#E0E0E0",
    amber: "#FFB000",
    pink: "#FF6B9D",
    blue: "#3B82F6",
    orange: "#FF9500",
    red: "#EF4444",
  };

  var MONO_FILL = "#E6E6E9";

  /* css: para previsualización y embeds · stops: para interpolar
     en SVG / ANSI / GIF (antes se extraían con regex del string css). */
  var GRADIENTS = {
    "gradient-purple": {
      css: "linear-gradient(135deg, #3C096C, #7B2CBF, #9D4EDD)",
      stops: ["#3C096C", "#7B2CBF", "#9D4EDD"],
    },
    "gradient-cyber": {
      css: "linear-gradient(135deg, #06b6d4, #8b5cf6, #ec4899)",
      stops: ["#06b6d4", "#8b5cf6", "#ec4899"],
    },
    "gradient-sunset": {
      css: "linear-gradient(135deg, #f97316, #ef4444, #ec4899)",
      stops: ["#f97316", "#ef4444", "#ec4899"],
    },
    "gradient-ocean": {
      css: "linear-gradient(135deg, #0ea5e9, #06b6d4, #10b981)",
      stops: ["#0ea5e9", "#06b6d4", "#10b981"],
    },
    "gradient-rainbow": {
      css: "linear-gradient(90deg, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)",
      stops: [
        "#ff0000",
        "#ff7f00",
        "#ffff00",
        "#00ff00",
        "#0000ff",
        "#4b0082",
        "#9400d3",
      ],
    },
    "gradient-neon": {
      css: "linear-gradient(135deg, #00ff87, #60efff, #00ff87)",
      stops: ["#00ff87", "#60efff", "#00ff87"],
    },
  };

  var CHAR_ASPECT = 1.65;
  var OUTPUT_BG = "#0A0A0B";
  var ANIM_FPS = 18;

  /* Cámara en vivo: tope de columnas del preview y cadencia de
         muestreo (~16 fps, dentro del rango 15-18 pedido). */
  var LIVE_MAX_COLS = 110;
  var CAM_SAMPLE_MS = 1000 / 16;

  var EFFECT_LABELS = {
    off: "estática",
    vibrate: "vibrar",
    wave: "ondas",
    matrix: "matrix",
    scan: "escaneo",
    glitch: "glitch",
    breathe: "respirar",
    rain: "lluvia",
    neon: "neon",
    cyber: "cyber",
    plasma: "plasma",
    pixelate: "pixelate",
  };

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades de color (para SVG / ANSI / GIF)                        */
  /* ------------------------------------------------------------------ */

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map((c) => {
          var h = Math.round(clamp(c, 0, 255)).toString(16);
          return h.length === 1 ? "0" + h : h;
        })
        .join("")
    );
  }

  /* Interpola los stops de un degradado en t ∈ [0, 1] → [r, g, b]. */
  function sampleGradient(stops, t) {
    if (stops.length === 1) return hexToRgb(stops[0]);
    var seg = clamp(t, 0, 1) * (stops.length - 1);
    var i = Math.min(Math.floor(seg), stops.length - 2);
    var f = seg - i;
    var a = hexToRgb(stops[i]);
    var b = hexToRgb(stops[i + 1]);
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ];
  }

  /* Resuelve el modo de color efectivo: el degradado (si hay) pisa el
     color sólido; 'mono' significa sin color. */
  function resolveColor(solidMode, gradientMode) {
    if (gradientMode && gradientMode !== "none" && GRADIENTS[gradientMode]) {
      return {
        kind: "gradient",
        key: gradientMode,
        stops: GRADIENTS[gradientMode].stops,
        css: GRADIENTS[gradientMode].css,
      };
    }
    if (solidMode && solidMode !== "mono" && COLORS[solidMode]) {
      return { kind: "solid", key: solidMode, hex: COLORS[solidMode] };
    }
    return { kind: "mono", key: "mono" };
  }

  /* ------------------------------------------------------------------ */
  /* Motor puro: conversión imagen → grilla de luminancia + ASCII       */
  /* ------------------------------------------------------------------ */

  /* Math portada intacta de v1.pixelsToAscii. opts: { density, inverted,
     contrast (-50..50), brightness (-50..50) }.
     Devuelve { ascii, grid } donde grid[y][x] es la luminancia ajustada. */
  function pixelsToAscii(data, width, height, opts) {
    var density = opts.density;
    var inverted = opts.inverted;
    var cFactor = 1 + opts.contrast / 50;
    var bAdj = opts.brightness * 3;
    var dLen = density.length;

    var ascii = "";
    var grid = [];

    for (var y = 0; y < height; y++) {
      var row = [];
      for (var x = 0; x < width; x++) {
        var idx = (y * width + x) * 4;
        var lum =
          0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        lum = 128 + (lum - 128) * cFactor + bAdj;
        lum = clamp(lum, 0, 255);
        row.push(lum);
        var ci = Math.floor((lum / 255) * (dLen - 1));
        if (inverted) ci = dLen - 1 - ci;
        ascii += density[ci];
      }
      grid.push(row);
      ascii += "\n";
    }
    return { ascii: ascii, grid: grid };
  }

  /* Gotas de "matrix": una por columna, con posición/velocidad/largo. */
  function createRainDrops(w, h) {
    var drops = [];
    for (var x = 0; x < w; x++) {
      drops.push({
        y: Math.random() * h * -1,
        speed: 0.3 + Math.random() * 0.7,
        length: 3 + Math.floor(Math.random() * 8),
      });
    }
    return drops;
  }

  function renderStatic(grid, w, h, density, inverted) {
    var dLen = density.length;
    var ascii = "";
    for (var y = 0; y < h; y++) {
      var row = grid[y];
      for (var x = 0; x < w; x++) {
        var ci = Math.floor((row[x] / 255) * (dLen - 1));
        if (inverted) ci = dLen - 1 - ci;
        ascii += density[ci];
      }
      ascii += "\n";
    }
    return ascii;
  }

  /* Renderiza un frame del efecto pedido. Math portada intacta de
     v1.renderFrame. Parámetros:
       grid, w, h  — grilla de luminancia
       mode        — 'off' | 'vibrate' | 'wave' | 'matrix' | 'scan' |
                     'glitch' | 'breathe' | 'rain' | 'neon' | 'cyber' |
                     'plasma' | 'pixelate'
       tMs         — tiempo en milisegundos (rAF o sintético para GIF)
       opts        — { density, inverted, speed, drops }  (drops se muta) */
  function computeFrame(grid, w, h, mode, tMs, opts) {
    var density = opts.density;
    var inverted = opts.inverted;
    var speed = opts.speed;
    var dLen = density.length;
    var time = tMs * 0.001 * speed;
    var ascii = "";
    var x, y, ci, val;

    if (mode === "vibrate") {
      var intensity = 3 * (255 / dLen);
      for (y = 0; y < h; y++) {
        var rowV = grid[y];
        for (x = 0; x < w; x++) {
          var jitter = (Math.random() - 0.5) * 2 * intensity;
          val = clamp(rowV[x] + jitter, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "wave") {
      var freq = 0.08;
      var amp = 40;
      var phase = time * 4;
      for (y = 0; y < h; y++) {
        var rowW = grid[y];
        for (x = 0; x < w; x++) {
          var wave =
            Math.sin(x * freq + phase) * amp +
            Math.sin(y * freq * 0.7 + phase * 0.6) * amp * 0.5;
          val = clamp(rowW[x] + wave, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "matrix") {
      var trails = new Uint8Array(w * h);
      for (x = 0; x < w; x++) {
        var drop = opts.drops[x];
        drop.y += drop.speed * speed;
        if (drop.y > h + drop.length) {
          drop.y = -drop.length - Math.random() * h * 0.5;
          drop.speed = 0.3 + Math.random() * 0.7;
          drop.length = 3 + Math.floor(Math.random() * 8);
        }
        var headY = Math.floor(drop.y);
        for (var i = 0; i < drop.length; i++) {
          var ty = headY - i;
          if (ty >= 0 && ty < h) {
            var brightness = i === 0 ? 2.0 : 1.0 - i / drop.length;
            trails[ty * w + x] = Math.max(
              trails[ty * w + x],
              Math.floor(brightness * 255),
            );
          }
        }
      }
      for (y = 0; y < h; y++) {
        var rowM = grid[y];
        for (x = 0; x < w; x++) {
          var trail = trails[y * w + x];
          if (trail > 100) {
            ci = Math.floor((1 - trail / 255) * (dLen - 1) * 0.5);
            ascii += density[ci];
          } else {
            ci = Math.floor((rowM[x] / 255) * (dLen - 1));
            ascii += inverted ? density[dLen - 1 - ci] : density[ci];
          }
        }
        ascii += "\n";
      }
    } else if (mode === "scan") {
      var scanY = ((time * 15) % (h + 20)) - 10;
      var band = 6;
      for (y = 0; y < h; y++) {
        var rowS = grid[y];
        var distS = Math.abs(y - scanY);
        var boostS = distS < band ? (1 - distS / band) * 100 : 0;
        for (x = 0; x < w; x++) {
          val = clamp(rowS[x] + boostS, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "glitch") {
      var shiftChance = 0.03 * speed;
      for (y = 0; y < h; y++) {
        var shift = 0;
        if (Math.random() < shiftChance) {
          shift = Math.floor((Math.random() - 0.5) * 12);
        }
        for (x = 0; x < w; x++) {
          var sx = clamp(x + shift, 0, w - 1);
          val = grid[y][sx];
          ci = Math.floor((val / 255) * (dLen - 1));
          if (Math.random() < 0.01 * speed) {
            ci = Math.floor(Math.random() * dLen);
          }
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "breathe") {
      var pulse = Math.sin(time * 2) * 30;
      for (y = 0; y < h; y++) {
        var rowB = grid[y];
        for (x = 0; x < w; x++) {
          val = clamp(rowB[x] + pulse, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "rain") {
      var numDrops = Math.floor(w * h * 0.008 * speed);
      var noiseMap = {};
      for (var n = 0; n < numDrops; n++) {
        var rx = Math.floor(Math.random() * w);
        var ry = Math.floor(Math.random() * h);
        noiseMap[ry * w + rx] = Math.random() * 255;
      }
      for (y = 0; y < h; y++) {
        var rowR = grid[y];
        for (x = 0; x < w; x++) {
          var key = y * w + x;
          if (Object.hasOwn(noiseMap, key)) {
            var nv = noiseMap[key];
            ci = Math.floor((nv / 255) * (dLen - 1));
            if (inverted) ci = dLen - 1 - ci;
            ascii += density[ci];
          } else {
            ci = Math.floor((rowR[x] / 255) * (dLen - 1));
            if (inverted) ci = dLen - 1 - ci;
            ascii += density[ci];
          }
        }
        ascii += "\n";
      }
    } else if (mode === "neon") {
      var pulseN = Math.sin(time * 3) * 20;
      var glowCenter = w / 2 + Math.sin(time * 2) * (w / 4);
      for (y = 0; y < h; y++) {
        var rowN = grid[y];
        for (x = 0; x < w; x++) {
          var distN = Math.abs(x - glowCenter);
          var boostN = Math.max(0, 100 - distN * 2) + pulseN;
          val = clamp(rowN[x] + boostN, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "cyber") {
      var scanYc = ((time * 10) % (h + 30)) - 15;
      var bandC = 8;
      for (y = 0; y < h; y++) {
        var rowC = grid[y];
        var distC = Math.abs(y - scanYc);
        var boostC = 0;
        if (distC < bandC) {
          boostC = (1 - distC / bandC) * 80 * (1 + Math.sin(time * 5) * 0.3);
        }
        for (x = 0; x < w; x++) {
          val = clamp(rowC[x] + boostC, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (Math.random() < 0.02 * speed) {
            ci = dLen - 1 - ci;
          }
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "plasma") {
      for (y = 0; y < h; y++) {
        var rowP = grid[y];
        for (x = 0; x < w; x++) {
          var v1 = Math.sin(x * 0.05 + time);
          var v2 = Math.sin(y * 0.05 + time * 0.5);
          var v3 = Math.sin((x + y) * 0.03 + time * 0.7);
          var v4 = Math.sin(Math.sqrt(x * x + y * y) * 0.03 + time);
          var plasma = ((v1 + v2 + v3 + v4) / 4) * 40;
          val = clamp(rowP[x] + plasma, 0, 255);
          ci = Math.floor((val / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          ascii += density[ci];
        }
        ascii += "\n";
      }
    } else if (mode === "pixelate") {
      /* v1 emitía '\n' dentro del bucle de columnas (salida rota);
         acá va por fila de bloque, como era la intención. */
      var ps = Math.max(2, Math.floor(4 + Math.sin(time) * 2));
      var rows = [];
      for (var by = 0; by < h; by += ps) {
        var blockRow = "";
        for (var bx = 0; bx < w; bx += ps) {
          var total = 0;
          var count = 0;
          for (var py = by; py < by + ps && py < h; py++) {
            for (var px = bx; px < bx + ps && px < w; px++) {
              total += grid[py][px];
              count++;
            }
          }
          var avg = total / count;
          ci = Math.floor((avg / 255) * (dLen - 1));
          if (inverted) ci = dLen - 1 - ci;
          var ch = density[ci];
          for (var k = 0; k < ps && bx + k < w; k++) blockRow += ch;
        }
        for (var r2 = 0; r2 < ps && by + r2 < h; r2++) rows.push(blockRow);
      }
      ascii = rows.join("\n") + "\n";
    } else {
      ascii = renderStatic(grid, w, h, density, inverted);
    }

    return ascii;
  }

  /* ------------------------------------------------------------------ */
  /* Exportadores puros: SVG y ANSI                                     */
  /* ------------------------------------------------------------------ */

  function escapeXml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* SVG autocontenido. Métricas monoespaciadas: avance ≈ 0.6em,
     alto de línea 1.15em. Monocromo → un fill; sólido → un fill;
     degradado → fill interpolado por fila. */
  function buildSvgOutput(rows, color) {
    var fs = 10;
    var adv = fs * 0.6;
    var lh = fs * 1.15;
    var pad = 8;

    var cols = 1;
    for (var i = 0; i < rows.length; i++) cols = Math.max(cols, rows[i].length);

    var W = Math.ceil(cols * adv + pad * 2);
    var H = Math.ceil(rows.length * lh + pad * 2);

    var out =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      W +
      '" height="' +
      H +
      '" viewBox="0 0 ' +
      W +
      " " +
      H +
      '" role="img" font-family="Courier New, Courier, monospace" font-size="' +
      fs +
      '">\n';
    out += "<title>Arte ASCII generado con dots — vicbas.com/dots</title>\n";
    out += '<rect width="100%" height="100%" fill="' + OUTPUT_BG + '"/>\n';

    for (var y = 0; y < rows.length; y++) {
      var fill;
      if (color.kind === "gradient") {
        fill = rgbToHex(
          sampleGradient(
            color.stops,
            rows.length > 1 ? y / (rows.length - 1) : 0,
          ),
        );
      } else if (color.kind === "solid") {
        fill = color.hex;
      } else {
        fill = MONO_FILL;
      }
      out +=
        '<text xml:space="preserve" x="' +
        pad +
        '" y="' +
        (pad + y * lh + fs * 0.8).toFixed(1) +
        '" fill="' +
        fill +
        '">' +
        escapeXml(rows[y]) +
        "</text>\n";
    }

    out += "</svg>\n";
    return out;
  }

  /* ANSI truecolor 24-bit (\\x1b[38;2;R;G;Bm). Monocromo → sin escapes;
     sólido → un escape por línea; degradado → color por carácter a lo
     largo de la diagonal, agrupando runs consecutivos del mismo color.
     Reset \\x1b[0m al final de cada línea coloreada. */
  function buildAnsiOutput(rows, color) {
    var ESC = "\u001b";

    if (color.kind === "mono") {
      return rows.join("\n") + "\n";
    }

    if (color.kind === "solid") {
      var rgb = hexToRgb(color.hex);
      var prefix =
        ESC +
        "[38;2;" +
        Math.round(rgb[0]) +
        ";" +
        Math.round(rgb[1]) +
        ";" +
        Math.round(rgb[2]) +
        "m";
      return rows.map((line) => prefix + line + ESC + "[0m").join("\n") + "\n";
    }

    var cols = 1;
    for (var i = 0; i < rows.length; i++) cols = Math.max(cols, rows[i].length);
    var diag = cols + rows.length - 2;

    return (
      rows
        .map((line, y) => {
          var out = "";
          var curKey = null;
          for (var x = 0; x < line.length; x++) {
            var t = diag > 0 ? (x + y) / diag : 0;
            var c = sampleGradient(color.stops, t);
            var key =
              Math.round(c[0]) +
              ";" +
              Math.round(c[1]) +
              ";" +
              Math.round(c[2]);
            if (key !== curKey) {
              out += ESC + "[38;2;" + key + "m";
              curKey = key;
            }
            out += line[x];
          }
          return out + ESC + "[0m";
        })
        .join("\n") + "\n"
    );
  }

  /* ------------------------------------------------------------------ */
  /* Generadores de código para incrustar (portados de v1, corregidos)  */
  /* ------------------------------------------------------------------ */

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function embedColorStyle(color) {
    if (color.kind === "gradient") {
      return (
        "background: " +
        color.css +
        ";\n        background-clip: text;\n        -webkit-background-clip: text;\n        -webkit-text-fill-color: transparent;"
      );
    }
    if (color.kind === "solid") {
      return "color: " + color.hex + ";";
    }
    return "color: " + MONO_FILL + ";";
  }

  function generateStaticCode(currentAscii, color, fontSize) {
    if (!currentAscii) return "";
    return (
      "<!-- Arte ASCII estático · generado en vicbas.com/dots -->\n" +
      "<style>\n" +
      "  .ascii-art {\n" +
      '    font-family: "Courier New", Courier, monospace;\n' +
      "    font-size: " +
      fontSize +
      "px;\n" +
      "    line-height: 1;\n" +
      "    letter-spacing: 0;\n" +
      "    white-space: pre;\n" +
      "    display: inline-block;\n" +
      "    " +
      embedColorStyle(color) +
      "\n" +
      "  }\n" +
      "  .ascii-container {\n" +
      "    background: " +
      OUTPUT_BG +
      ";\n" +
      "    padding: 12px;\n" +
      "    border-radius: 10px;\n" +
      "    border: 1px solid rgba(255, 255, 255, 0.08);\n" +
      "    display: flex;\n" +
      "    justify-content: center;\n" +
      "    overflow: auto;\n" +
      "    max-height: 80vh;\n" +
      "  }\n" +
      "</style>\n\n" +
      '<div class="ascii-container">\n' +
      '  <pre class="ascii-art">' +
      escapeHtml(currentAscii) +
      "</pre>\n" +
      "</div>"
    );
  }

  function generateAnimatedCode(
    grid,
    w,
    h,
    color,
    fontSize,
    effect,
    speedValue,
    density,
    inverted,
  ) {
    if (!grid || !grid.length) return "";
    if (effect === "off") effect = "wave";

    var gridStr = grid
      .map((r) => r.map((v) => Math.round(v)).join(","))
      .join("],[");

    /* v1 interpolaba el charset sin escapar: con "ultra" (contiene
       barra invertida y comilla simple) el código generado rompía. */
    var densityLiteral =
      "'" + density.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

    return (
      "<!-- Arte ASCII animado (" +
      EFFECT_LABELS[effect] +
      ") · generado en vicbas.com/dots -->\n" +
      "<style>\n" +
      "  .ascii-art {\n" +
      '    font-family: "Courier New", Courier, monospace;\n' +
      "    font-size: " +
      fontSize +
      "px;\n" +
      "    line-height: 1;\n" +
      "    letter-spacing: 0;\n" +
      "    white-space: pre;\n" +
      "    display: inline-block;\n" +
      "    " +
      embedColorStyle(color) +
      "\n" +
      "  }\n" +
      "  .ascii-container {\n" +
      "    background: " +
      OUTPUT_BG +
      ";\n" +
      "    padding: 12px;\n" +
      "    border-radius: 10px;\n" +
      "    border: 1px solid rgba(255, 255, 255, 0.08);\n" +
      "    display: flex;\n" +
      "    justify-content: center;\n" +
      "    overflow: auto;\n" +
      "    max-height: 80vh;\n" +
      "  }\n" +
      "</style>\n\n" +
      '<div class="ascii-container">\n' +
      '  <pre class="ascii-art" id="asciiAnim"></pre>\n' +
      "</div>\n\n" +
      "<script>\n" +
      "(function() {\n" +
      "  var grid = [[" +
      gridStr +
      "]];\n" +
      "  var W = " +
      w +
      ";\n" +
      "  var H = " +
      h +
      ";\n" +
      "  var density = " +
      densityLiteral +
      ";\n" +
      "  var inverted = " +
      inverted +
      ";\n" +
      "  var dLen = density.length;\n" +
      "  var speed = " +
      speedValue +
      " / 5;\n" +
      '  var mode = "' +
      effect +
      '";\n' +
      '  var el = document.getElementById("asciiAnim");\n' +
      "  var drops = [];\n" +
      "  for (var i = 0; i < W; i++) drops.push({ y: Math.random()*H*-1, s: 0.3+Math.random()*0.7, l: 3+Math.floor(Math.random()*8) });\n" +
      "  var fps = 18, last = 0;\n" +
      "\n" +
      "  function clamp(v, mn, mx) { return v < mn ? mn : v > mx ? mx : v; }\n" +
      "\n" +
      "  function render(t) {\n" +
      "    var time = t * 0.001 * speed;\n" +
      '    var ascii = "";\n' +
      "    var x, y, ci, val;\n" +
      "\n" +
      '    if (mode === "wave") {\n' +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var wave = Math.sin(x*0.08+time*4)*40 + Math.sin(y*0.056+time*2.4)*20;\n" +
      "          val = clamp(grid[y][x]+wave,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "vibrate") {\n' +
      "      var inten = 3*(255/dLen);\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var j = (Math.random()-0.5)*2*inten;\n" +
      "          val = clamp(grid[y][x]+j,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "breathe") {\n' +
      "      var pulse = Math.sin(time*2)*30;\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          val = clamp(grid[y][x]+pulse,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "scan") {\n' +
      "      var scanY = ((time*15)%(H+20))-10;\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        var dist = Math.abs(y-scanY);\n" +
      "        var boost = dist < 6 ? (1-dist/6)*100 : 0;\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          val = clamp(grid[y][x]+boost,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "glitch") {\n' +
      "      for (y = 0; y < H; y++) {\n" +
      "        var shift = Math.random() < 0.03*speed ? Math.floor((Math.random()-0.5)*12) : 0;\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var sx = clamp(x+shift,0,W-1);\n" +
      "          ci = Math.floor((grid[y][sx]/255)*(dLen-1));\n" +
      "          if (Math.random() < 0.01*speed) ci = Math.floor(Math.random()*dLen);\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "matrix") {\n' +
      "      var trails = new Uint8Array(W*H);\n" +
      "      for (x = 0; x < W; x++) {\n" +
      "        var d = drops[x];\n" +
      "        d.y += d.s * speed;\n" +
      "        if (d.y > H + d.l) { d.y = -d.l - Math.random()*H*0.5; d.s = 0.3+Math.random()*0.7; d.l = 3+Math.floor(Math.random()*8); }\n" +
      "        var headY = Math.floor(d.y);\n" +
      "        for (var ti = 0; ti < d.l; ti++) {\n" +
      "          var ty = headY - ti;\n" +
      "          if (ty >= 0 && ty < H) {\n" +
      "            var br = ti === 0 ? 2.0 : (1.0 - ti/d.l);\n" +
      "            trails[ty*W+x] = Math.max(trails[ty*W+x], Math.floor(br*255));\n" +
      "          }\n" +
      "        }\n" +
      "      }\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var trail = trails[y*W+x];\n" +
      "          if (trail > 100) {\n" +
      "            ci = Math.floor((1 - trail/255)*(dLen-1)*0.5);\n" +
      "            ascii += density[ci];\n" +
      "          } else {\n" +
      "            ci = Math.floor((grid[y][x]/255)*(dLen-1));\n" +
      "            ascii += inverted ? density[dLen-1-ci] : density[ci];\n" +
      "          }\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "rain") {\n' +
      "      var numD = Math.floor(W*H*0.008*speed);\n" +
      "      var noise = {};\n" +
      "      for (var ri = 0; ri < numD; ri++) noise[Math.floor(Math.random()*H)*W+Math.floor(Math.random()*W)] = Math.random()*255;\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var k = y*W+x;\n" +
      "          var v = Object.prototype.hasOwnProperty.call(noise, k) ? noise[k] : grid[y][x];\n" +
      "          ci = Math.floor((v/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "neon") {\n' +
      "      var pulse = Math.sin(time*3)*20;\n" +
      "      var glowCenter = (W/2) + Math.sin(time*2)*(W/4);\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var nd = Math.abs(x-glowCenter);\n" +
      "          var nb = Math.max(0, 100-nd*2) + pulse;\n" +
      "          val = clamp(grid[y][x]+nb,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "cyber") {\n' +
      "      var scanY = ((time*10)%(H+30))-15;\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        var cd = Math.abs(y-scanY);\n" +
      "        var cb = cd < 8 ? (1-cd/8)*80*(1+Math.sin(time*5)*0.3) : 0;\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          val = clamp(grid[y][x]+cb,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (Math.random() < 0.02*speed) ci = dLen-1-ci;\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "plasma") {\n' +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          var v1 = Math.sin(x*0.05+time);\n" +
      "          var v2 = Math.sin(y*0.05+time*0.5);\n" +
      "          var v3 = Math.sin((x+y)*0.03+time*0.7);\n" +
      "          var v4 = Math.sin(Math.sqrt(x*x+y*y)*0.03+time);\n" +
      "          var pl = ((v1+v2+v3+v4)/4)*40;\n" +
      "          val = clamp(grid[y][x]+pl,0,255);\n" +
      "          ci = Math.floor((val/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      '    else if (mode === "pixelate") {\n' +
      "      var ps = Math.max(2, Math.floor(4+Math.sin(time)*2));\n" +
      "      var outRows = [];\n" +
      "      for (var by = 0; by < H; by += ps) {\n" +
      '        var blockRow = "";\n' +
      "        for (var bx = 0; bx < W; bx += ps) {\n" +
      "          var s = 0, c = 0;\n" +
      "          for (var py = by; py < by+ps && py < H; py++) {\n" +
      "            for (var px = bx; px < bx+ps && px < W; px++) { s += grid[py][px]; c++; }\n" +
      "          }\n" +
      "          ci = Math.floor(((s/c)/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          var ch = density[ci];\n" +
      "          for (var kk = 0; kk < ps && bx+kk < W; kk++) blockRow += ch;\n" +
      "        }\n" +
      "        for (var rr = 0; rr < ps && by+rr < H; rr++) outRows.push(blockRow);\n" +
      "      }\n" +
      '      ascii = outRows.join("\\n");\n' +
      "    }\n" +
      "    else {\n" +
      "      for (y = 0; y < H; y++) {\n" +
      "        for (x = 0; x < W; x++) {\n" +
      "          ci = Math.floor((grid[y][x]/255)*(dLen-1));\n" +
      "          if (inverted) ci = dLen-1-ci;\n" +
      "          ascii += density[ci];\n" +
      "        }\n" +
      '        ascii += "\\n";\n' +
      "      }\n" +
      "    }\n" +
      "\n" +
      "    el.textContent = ascii;\n" +
      "  }\n" +
      "\n" +
      "  function loop(ts) {\n" +
      "    if (ts - last >= 1000/fps) { last = ts; render(ts); }\n" +
      "    requestAnimationFrame(loop);\n" +
      "  }\n" +
      "  requestAnimationFrame(loop);\n" +
      "})();\n" +
      "</script>"
    );
  }

  /* ------------------------------------------------------------------ */
  /* Cámara en vivo: utilidades puras (sin DOM, verificables por consola) */
  /* ------------------------------------------------------------------ */

  /* Reflejo horizontal para dibujar un frame de ancho `width`:
         ctx.translate(dx, 0); ctx.scale(sx, 1); antes del drawImage. */
  function mirrorTransform(enabled, width) {
    return enabled ? [width, -1] : [0, 1];
  }

  /* Espejo por defecto según la cámara: frontal sí, trasera no. */
  function mirrorForFacingMode(facingMode, fallback) {
    if (facingMode === "environment") return false;
    if (facingMode === "user") return true;
    return fallback;
  }

  /* ¿Ya pasó el intervalo de muestreo? (throttle del bucle en vivo) */
  function fpsReady(now, last, intervalMs) {
    return !last || now - last >= intervalMs;
  }

  /* Tamaño de la grilla en vivo: columnas pedidas con tope máximo y
         corrección de aspecto de caracteres, igual que convert(). */
  function liveGridSize(videoW, videoH, requestedCols, maxCols, aspect) {
    var width = clamp(Math.min(requestedCols, maxCols), 1, maxCols);
    var height = Math.max(1, Math.round(((videoH / videoW) * width) / aspect));
    return { width: width, height: height };
  }

  /* Detiene todas las pistas de un stream; devuelve cuántas había. */
  function stopStreamTracks(stream) {
    if (!stream || !stream.getTracks) return 0;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].stop) tracks[i].stop();
    }
    return tracks.length;
  }

  /* Mensaje en español para los errores típicos de getUserMedia. */
  function cameraErrorMessage(err) {
    var name = err && err.name ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "permiso denegado — habilitá la cámara en el navegador";
    }
    if (
      name === "NotFoundError" ||
      name === "DevicesNotFoundError" ||
      name === "OverconstrainedError"
    ) {
      return "no hay cámara disponible";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "la cámara está en uso por otra aplicación";
    }
    if (name === "SecurityError") {
      return "se necesita HTTPS para usar la cámara";
    }
    if (name === "AbortError") {
      return "no se pudo iniciar la cámara";
    }
    return err && err.message ? err.message : "no se pudo acceder a la cámara";
  }

  /* ------------------------------------------------------------------ */
  /* Gancho de depuración / pruebas (funciones puras, sin DOM)          */
  /* ------------------------------------------------------------------ */

  if (typeof window !== "undefined") {
    window.dotsEngine = {
      DENSITY_SCALES: DENSITY_SCALES,
      COLORS: COLORS,
      GRADIENTS: GRADIENTS,
      CHAR_ASPECT: CHAR_ASPECT,
      pixelsToAscii: pixelsToAscii,
      computeFrame: computeFrame,
      createRainDrops: createRainDrops,
      renderStatic: renderStatic,
      buildSvgOutput: buildSvgOutput,
      buildAnsiOutput: buildAnsiOutput,
      resolveColor: resolveColor,
      sampleGradient: sampleGradient,
      generateStaticCode: generateStaticCode,
      generateAnimatedCode: generateAnimatedCode,
      LIVE_MAX_COLS: LIVE_MAX_COLS,
      CAM_SAMPLE_MS: CAM_SAMPLE_MS,
      mirrorTransform: mirrorTransform,
      mirrorForFacingMode: mirrorForFacingMode,
      fpsReady: fpsReady,
      liveGridSize: liveGridSize,
      stopStreamTracks: stopStreamTracks,
      cameraErrorMessage: cameraErrorMessage,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Aplicación (DOM)                                                   */
  /* ------------------------------------------------------------------ */

  function init() {
    var $ = (id) => document.getElementById(id);

    var dropZone = $("dropZone");
    var fileInput = $("fileInput");
    var workspace = $("workspace");
    var previewImg = $("previewImg");
    var imgInfo = $("imgInfo");
    var gridInfo = $("gridInfo");
    var modeTag = $("modeTag");
    var asciiOutput = $("asciiOutput");
    var hiddenCanvas = $("hiddenCanvas");
    var hCtx = hiddenCanvas.getContext("2d", { willReadFrequently: true });

    var resolutionSlider = $("resolution");
    var resValue = $("resValue");
    var contrastSlider = $("contrast");
    var contrastValue = $("contrastValue");
    var brightnessSlider = $("brightness");
    var brightnessValue = $("brightnessValue");
    var invertSelect = $("invertMode");
    var densitySelect = $("densityScale");
    var fontSizeSlider = $("fontSize");
    var fontValue = $("fontValue");
    var colorSelect = $("colorMode");
    var gradientSelect = $("gradientMode");
    var animModeSelect = $("animMode");
    var animSpeedSlider = $("animSpeed");
    var animSpeedValue = $("animSpeedValue");
    var animSpeedField = $("animSpeedField");
    var downloadGifBtn = $("downloadGifBtn");

    var statusState = $("statusState");

    var camStartBtn = $("camStartBtn");
    var camCaptureBtn = $("camCaptureBtn");
    var camStopBtn = $("camStopBtn");
    var camMirrorBtn = $("camMirrorBtn");
    var camMirrorState = $("camMirrorState");
    var camDevice = $("camDevice");
    var camDeviceField = $("camDeviceField");
    var dzCamBtn = $("dzCamBtn");

    var currentImage = null;
    var currentAscii = "";
    var luminanceGrid = null;
    var gridWidth = 0;
    var gridHeight = 0;
    var animId = null;
    var settingsTimeout = null;
    var rainDrops = [];

    /* Estado de la cámara en vivo. camUiActive = la UI está en modo
           cámara; camActive = hay stream y bucle corriendo (divergen solo
           durante un cambio de dispositivo o un pagehide). La grilla en
           vivo (liveGrid) es independiente del estado estático que usan
           las exportaciones, así no se corrompen entre sí. */
    var camUiActive = false;
    var camActive = false;
    var camPaused = false;
    var camStream = null;
    var camVideo = null;
    var camRafId = null;
    var camMirror = true;
    var camStatusTimer = null;
    var liveGrid = null;
    var liveW = 0;
    var liveH = 0;
    var liveDrops = [];
    var liveInfoKey = "";
    var cameraSupported = !!(
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    );

    /* ----- estado ----- */

    function setStatus(text, kind) {
      statusState.textContent = text;
      statusState.parentElement.setAttribute("data-kind", kind || "ready");
      /* Con la cámara abierta, los avisos transitorios (ok/busy)
             vuelven solos al indicador de privacidad. */
      if (camUiActive && (kind === "ok" || kind === "busy")) {
        clearTimeout(camStatusTimer);
        camStatusTimer = setTimeout(() => {
          if (camUiActive) camStatus();
        }, 1600);
      }
    }

    function effectiveColor() {
      return resolveColor(colorSelect.value, gradientSelect.value);
    }

    function readParams() {
      return {
        densityKey: densitySelect.value,
        density: DENSITY_SCALES[densitySelect.value],
        inverted: invertSelect.value === "yes",
        contrast: parseInt(contrastSlider.value, 10),
        brightness: parseInt(brightnessSlider.value, 10),
        resolution: parseInt(resolutionSlider.value, 10),
        fontSize: parseInt(fontSizeSlider.value, 10),
        effect: animModeSelect.value,
        speed: parseInt(animSpeedSlider.value, 10) / 5,
        color: effectiveColor(),
      };
    }

    /* ----- carga de imagen (drag & drop, picker, Ctrl+V) ----- */

    dropZone.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("button")) return;
      fileInput.click();
    });

    dropZone.addEventListener("keydown", (e) => {
      if (e.target !== dropZone) return; // los botones internos manejan sus teclas
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      var file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadImage(file);
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) loadImage(e.target.files[0]);
    });

    window.addEventListener("paste", (e) => {
      if (!e.clipboardData) return;
      var items = e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
          var file = it.getAsFile();
          if (file) {
            e.preventDefault();
            loadImage(file);
            return;
          }
        }
      }
    });

    $("newImage").addEventListener("click", resetAll);

    function resetAll() {
      stopCamera();
      stopAnimation();
      workspace.hidden = true;
      dropZone.hidden = false;
      fileInput.value = "";
      currentImage = null;
      currentAscii = "";
      luminanceGrid = null;
      rainDrops = [];
      previewImg.hidden = true;
      setStatus("LISTO", "ready");
    }

    function loadImage(file) {
      if (!file || !file.type || file.type.indexOf("image/") !== 0) {
        setStatus(
          "ERROR — seleccioná un archivo de imagen válido (PNG, JPG, WebP)",
          "error",
        );
        return;
      }

      var reader = new FileReader();
      reader.onload = (ev) => {
        var dataUrl = ev.target.result;
        previewImg.src = dataUrl;

        var img = new Image();
        img.onload = () => {
          currentImage = img;
          previewImg.hidden = false;
          imgInfo.textContent =
            img.width +
            "×" +
            img.height +
            "px · " +
            (file.size / 1024).toFixed(1) +
            "KB";
          dropZone.hidden = true;
          workspace.hidden = false;
          applyAsciiColor();
          convert();
          setStatus(
            "IMAGEN CARGADA — " + img.width + "×" + img.height + "px",
            "ok",
          );
        };
        img.onerror = () => {
          setStatus(
            "ERROR — no se pudo decodificar la imagen, probá con otro archivo",
            "error",
          );
        };
        img.src = dataUrl;
      };
      reader.onerror = () => {
        setStatus("ERROR — no se pudo leer el archivo", "error");
      };
      reader.readAsDataURL(file);
    }

    /* ----- conversión ----- */

    function convert() {
      if (!currentImage) return;
      var p = readParams();

      var width = p.resolution;
      var height = Math.max(
        1,
        Math.round(
          ((currentImage.height / currentImage.width) * width) / CHAR_ASPECT,
        ),
      );

      hiddenCanvas.width = width;
      hiddenCanvas.height = height;
      hCtx.drawImage(currentImage, 0, 0, width, height);

      var data = hCtx.getImageData(0, 0, width, height).data;
      var result = pixelsToAscii(data, width, height, {
        density: p.density,
        inverted: p.inverted,
        contrast: p.contrast,
        brightness: p.brightness,
      });

      currentAscii = result.ascii;
      luminanceGrid = result.grid;
      gridWidth = width;
      gridHeight = height;

      gridInfo.textContent =
        width + "×" + height + " caracteres · " + p.densityKey;

      rainDrops = createRainDrops(width, height);

      applyModeUi();
    }

    function applyModeUi() {
      var p = readParams();
      animSpeedField.classList.toggle("is-hidden", p.effect === "off");
      downloadGifBtn.hidden = !(p.effect !== "off" && luminanceGrid);

      if (camUiActive) {
        /* El bucle de la cámara es dueño del render y de la barra de
               estado: los controles aplican en vivo en el próximo tick. */
        modeTag.textContent =
          "cámara" +
          (p.effect === "off"
            ? ""
            : " · " + (EFFECT_LABELS[p.effect] || p.effect));
        return;
      }

      var animating = p.effect !== "off" && luminanceGrid;
      modeTag.textContent = EFFECT_LABELS[p.effect] || p.effect;

      if (animating) {
        startAnimation();
        setStatus(
          "ANIMANDO · " + (EFFECT_LABELS[p.effect] || p.effect),
          "busy",
        );
      } else {
        stopAnimation();
        asciiOutput.textContent = currentAscii;
        if (currentImage)
          setStatus(
            "IMAGEN CARGADA — " +
              currentImage.width +
              "×" +
              currentImage.height +
              "px",
            "ok",
          );
      }
    }

    /* ----- color de la vista previa ----- */

    function applyAsciiColor() {
      var color = effectiveColor();
      asciiOutput.classList.remove("is-gradient");
      asciiOutput.style.background = "transparent";
      asciiOutput.style.webkitTextFillColor = "";
      if (color.kind === "gradient") {
        asciiOutput.style.background = color.css;
        asciiOutput.classList.add("is-gradient");
      } else if (color.kind === "solid") {
        asciiOutput.style.color = color.hex;
      } else {
        asciiOutput.style.color = MONO_FILL;
      }
    }

    /* ----- animación en vivo (18 fps, como v1) ----- */

    function startAnimation() {
      stopAnimation();
      if (camUiActive) return;
      if (
        !luminanceGrid ||
        !luminanceGrid.length ||
        animModeSelect.value === "off"
      )
        return;

      var lastTime = 0;

      function loop(ts) {
        if (ts - lastTime >= 1000 / ANIM_FPS) {
          lastTime = ts;
          var p = readParams();
          currentAscii = computeFrame(
            luminanceGrid,
            gridWidth,
            gridHeight,
            p.effect,
            ts,
            {
              density: p.density,
              inverted: p.inverted,
              speed: p.speed,
              drops: rainDrops,
            },
          );
          asciiOutput.textContent = currentAscii;
        }
        animId = requestAnimationFrame(loop);
      }
      animId = requestAnimationFrame(loop);
    }

    function stopAnimation() {
      if (animId) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    }

    /* ----- cámara en vivo ----- */

    function camStatus() {
      statusState.textContent = "● CÁMARA ACTIVA";
      statusState.parentElement.setAttribute("data-kind", "live");
    }

    function updateCameraUi() {
      camStartBtn.hidden = camUiActive;
      camStartBtn.disabled = camUiActive || !cameraSupported;
      camCaptureBtn.hidden = !camUiActive;
      camCaptureBtn.disabled = !camUiActive;
      camStopBtn.hidden = !camUiActive;
      camMirrorBtn.hidden = !camUiActive;
      dzCamBtn.disabled = camUiActive || !cameraSupported;
    }

    function ensureVideoElement() {
      if (camVideo) return;
      camVideo = document.createElement("video");
      /* playsinline importa en iOS; muted+autoplay evitan el bloqueo
             de reproducción automática. */
      camVideo.setAttribute("playsinline", "");
      camVideo.setAttribute("autoplay", "");
      camVideo.setAttribute("muted", "");
      camVideo.muted = true;
      camVideo.style.display = "none";
      camVideo.addEventListener("loadedmetadata", refreshLiveMeta);
      document.body.appendChild(camVideo);
    }

    function readFacingMode() {
      try {
        var tracks = camStream.getVideoTracks();
        if (tracks.length && tracks[0].getSettings) {
          var s = tracks[0].getSettings();
          if (s && s.facingMode) return s.facingMode;
        }
      } catch {
        /* algunos navegadores no exponen getSettings */
      }
      return null;
    }

    function setMirrorUi(value) {
      camMirror = value;
      camMirrorBtn.setAttribute("aria-pressed", String(value));
      camMirrorState.textContent = value ? "sí" : "no";
    }

    function refreshLiveMeta() {
      if (!camUiActive || !camVideo || !camVideo.videoWidth) return;
      if (!currentImage) {
        imgInfo.textContent =
          "cámara · " + camVideo.videoWidth + "×" + camVideo.videoHeight + "px";
      }
    }

    function refreshCameraDevices() {
      if (!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices))
        return;
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (!camUiActive) return;
          var cams = devices.filter((d) => d.kind === "videoinput");
          if (cams.length > 1) {
            camDevice.innerHTML = "";
            cams.forEach((d, i) => {
              var opt = document.createElement("option");
              opt.value = d.deviceId;
              opt.textContent = d.label || "cámara " + (i + 1);
              camDevice.appendChild(opt);
            });
            var cur = currentVideoDeviceId();
            if (cur) camDevice.value = cur;
            camDeviceField.classList.remove("is-hidden");
          } else {
            camDeviceField.classList.add("is-hidden");
          }
        })
        .catch(() => {
          /* sin lista de dispositivos: el selector queda oculto */
        });
    }

    function currentVideoDeviceId() {
      if (!camStream) return null;
      var tracks = camStream.getVideoTracks();
      if (tracks.length && tracks[0].getSettings) {
        var s = tracks[0].getSettings();
        return (s && s.deviceId) || null;
      }
      return null;
    }

    function openCameraStream(deviceId) {
      if (!cameraSupported) {
        setStatus("CÁMARA NO DISPONIBLE (SE REQUIERE HTTPS)", "warn");
        return;
      }
      var switching = camUiActive;
      if (camActive) teardownCamera();
      setStatus(
        switching ? "CAMBIANDO DE CÁMARA…" : "SOLICITANDO ACCESO A LA CÁMARA…",
        "busy",
      );

      var video = deviceId
        ? {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          };

      navigator.mediaDevices
        .getUserMedia({ video: video, audio: false })
        .then(attachCameraStream)
        .catch((err) => {
          console.error("Error de cámara:", err);
          if (switching) {
            camUiActive = false;
            updateCameraUi();
            restoreAfterCameraStop(
              "ERROR — " + cameraErrorMessage(err),
              "error",
            );
          } else {
            setStatus("ERROR — " + cameraErrorMessage(err), "error");
          }
        });
    }

    function attachCameraStream(stream) {
      teardownCamera(); // por si veníamos de un cambio de dispositivo
      camStream = stream;
      ensureVideoElement();
      camVideo.srcObject = stream;
      var p = camVideo.play();
      if (p && p.catch) p.catch(() => {});

      stream.getVideoTracks().forEach((t) => {
        t.addEventListener("ended", onCameraTrackEnded);
      });

      camActive = true;
      camPaused = document.hidden;
      camUiActive = true;

      var facing = readFacingMode();
      if (facing) setMirrorUi(mirrorForFacingMode(facing, camMirror));

      stopAnimation();
      dropZone.hidden = true;
      workspace.hidden = false;
      previewImg.hidden = !currentImage;
      liveInfoKey = "";
      applyAsciiColor();
      applyModeUi();
      startCameraLoop();
      refreshCameraDevices();
      updateCameraUi();
      camStatus();
    }

    function onCameraTrackEnded() {
      if (!camUiActive) return;
      stopCamera("CÁMARA DESCONECTADA", "warn");
    }

    function startCameraLoop() {
      stopCameraLoop();
      camPaused = document.hidden;
      var last = 0;

      function tick(ts) {
        camRafId = requestAnimationFrame(tick);
        if (camPaused) return;
        if (!fpsReady(ts, last, CAM_SAMPLE_MS)) return;
        last = ts;
        if (camVideo && camVideo.videoWidth && camVideo.readyState >= 2)
          sampleCameraFrame(ts);
      }
      camRafId = requestAnimationFrame(tick);
    }

    function stopCameraLoop() {
      if (camRafId) {
        cancelAnimationFrame(camRafId);
        camRafId = null;
      }
    }

    /* Muestrea el <video> al mismo canvas y con el mismo pipeline que
           una imagen estática (pixelsToAscii → computeFrame), con tope de
           columnas y ~16 fps. La grilla en vivo es aparte (liveGrid) para
           no pisar el estado estático que usan las exportaciones. */
    function sampleCameraFrame(ts) {
      var p = readParams();
      var size = liveGridSize(
        camVideo.videoWidth,
        camVideo.videoHeight,
        p.resolution,
        LIVE_MAX_COLS,
        CHAR_ASPECT,
      );
      var w = size.width;
      var h = size.height;
      if (w !== liveW || h !== liveH) {
        liveW = w;
        liveH = h;
        liveDrops = createRainDrops(w, h);
      }

      hiddenCanvas.width = w;
      hiddenCanvas.height = h;
      var mt = mirrorTransform(camMirror, w);
      hCtx.save();
      hCtx.translate(mt[0], 0);
      hCtx.scale(mt[1], 1);
      hCtx.drawImage(camVideo, 0, 0, w, h);
      hCtx.restore();

      var data = hCtx.getImageData(0, 0, w, h).data;
      var result = pixelsToAscii(data, w, h, {
        density: p.density,
        inverted: p.inverted,
        contrast: p.contrast,
        brightness: p.brightness,
      });
      liveGrid = result.grid;

      var frame;
      if (p.effect === "off") {
        frame = result.ascii;
      } else {
        frame = computeFrame(liveGrid, w, h, p.effect, ts, {
          density: p.density,
          inverted: p.inverted,
          speed: p.speed,
          drops: liveDrops,
        });
      }
      asciiOutput.textContent = frame;

      var infoKey = w + "×" + h + ":" + p.densityKey;
      if (infoKey !== liveInfoKey) {
        liveInfoKey = infoKey;
        gridInfo.textContent = w + "×" + h + " caracteres · " + p.densityKey;
      }
    }

    function teardownCamera() {
      stopCameraLoop();
      if (camVideo) camVideo.srcObject = null;
      stopStreamTracks(camStream);
      camStream = null;
      camActive = false;
      camPaused = false;
      clearTimeout(camStatusTimer);
    }

    function stopCamera(message, kind) {
      if (!camUiActive) return;
      teardownCamera();
      camUiActive = false;
      updateCameraUi();
      restoreAfterCameraStop(message, kind);
    }

    /* Vuelve al estado estático: la imagen cargada (o la última
           capturada) si existe; si no, de vuelta a la zona de carga. */
    function restoreAfterCameraStop(message, kind) {
      if (currentImage) {
        convert();
        if (message) setStatus(message, kind || "ok");
      } else {
        currentAscii = "";
        luminanceGrid = null;
        gridWidth = 0;
        gridHeight = 0;
        rainDrops = [];
        workspace.hidden = true;
        dropZone.hidden = false;
        previewImg.hidden = true;
        setStatus(message || "CÁMARA DETENIDA", kind || "ready");
      }
    }

    /* Captura el fotograma actual a resolución nativa y lo mete por
           el mismo camino que una subida de archivo: dataURL → imagen →
           convert(). La cámara sigue abierta para capturar varias veces. */
    function captureFrame() {
      if (!camActive || !camVideo || !camVideo.videoWidth) {
        setStatus("ERROR — no hay fotograma para capturar", "error");
        return;
      }
      var w = camVideo.videoWidth;
      var h = camVideo.videoHeight;
      var cap = document.createElement("canvas");
      cap.width = w;
      cap.height = h;
      var ctx = cap.getContext("2d");
      var mt = mirrorTransform(camMirror, w);
      ctx.translate(mt[0], 0);
      ctx.scale(mt[1], 1);
      ctx.drawImage(camVideo, 0, 0, w, h);

      var dataUrl = cap.toDataURL("image/jpeg", 0.92);
      var approxKb = Math.round((dataUrl.length * 0.75) / 1024);
      previewImg.src = dataUrl;

      var img = new Image();
      img.onload = () => {
        currentImage = img;
        previewImg.hidden = false;
        imgInfo.textContent =
          img.width + "×" + img.height + "px · captura " + approxKb + "KB";
        convert(); // estado estático a resolución completa → exportaciones listas
        refreshLiveMeta(); // la vista sigue mostrando la cámara en vivo
        setStatus("FOTOGRAMA CAPTURADO", "ok");
      };
      img.onerror = () => {
        setStatus("ERROR — no se pudo decodificar la captura", "error");
      };
      img.src = dataUrl;
    }

    camStartBtn.addEventListener("click", () => openCameraStream());
    dzCamBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCameraStream();
    });
    camCaptureBtn.addEventListener("click", captureFrame);
    camStopBtn.addEventListener("click", () => stopCamera());
    camMirrorBtn.addEventListener("click", () => setMirrorUi(!camMirror));
    camDevice.addEventListener("change", () => {
      if (camUiActive && camDevice.value) openCameraStream(camDevice.value);
    });

    document.addEventListener("visibilitychange", () => {
      if (!camActive) return;
      camPaused = document.hidden;
      if (!camPaused) camStatus();
    });

    /* Al ocultar la página se libera la cámara (pagehide cubre también
           el bfcache); si se vuelve atrás, pageshow restaura el estado. */
    window.addEventListener("pagehide", () => {
      if (camActive) teardownCamera();
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted && camUiActive) stopCamera();
    });

    /* ----- controles ----- */

    function onSettingsChange() {
      if (camUiActive) return; // el bucle en vivo releé los parámetros en cada tick
      if (currentImage) {
        clearTimeout(settingsTimeout);
        settingsTimeout = setTimeout(convert, 300);
      }
    }

    resolutionSlider.addEventListener("input", () => {
      resValue.textContent = resolutionSlider.value;
      onSettingsChange();
    });

    contrastSlider.addEventListener("input", () => {
      contrastValue.textContent = contrastSlider.value;
      onSettingsChange();
    });

    brightnessSlider.addEventListener("input", () => {
      brightnessValue.textContent = brightnessSlider.value;
      onSettingsChange();
    });

    fontSizeSlider.addEventListener("input", () => {
      fontValue.textContent = fontSizeSlider.value + "px";
      asciiOutput.style.fontSize = fontSizeSlider.value + "px";
    });

    densitySelect.addEventListener("change", onSettingsChange);
    invertSelect.addEventListener("change", onSettingsChange);
    colorSelect.addEventListener("change", applyAsciiColor);
    gradientSelect.addEventListener("change", applyAsciiColor);

    animModeSelect.addEventListener("change", () => {
      if (animModeSelect.value !== "off") {
        rainDrops = createRainDrops(gridWidth, gridHeight);
      }
      applyModeUi();
    });

    animSpeedSlider.addEventListener("input", () => {
      animSpeedValue.textContent = animSpeedSlider.value;
    });

    /* ----- utilidades de exportación ----- */

    function downloadBlob(content, filename, mime) {
      var blob =
        content instanceof Blob ? content : new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }

    /* Con la cámara en vivo y sin captura todavía no hay contenido
           exportable; en el resto de los casos siempre hay currentAscii. */
    function ensureExportSource() {
      if (currentAscii) return true;
      setStatus("CARGÁ UNA IMAGEN O CAPTURÁ UN FOTOGRAMA", "warn");
      return false;
    }

    function currentRows() {
      var ascii = currentAscii || "";
      if (ascii.slice(-1) === "\n") ascii = ascii.slice(0, -1);
      return ascii.split("\n");
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard
          .writeText(text)
          .catch(() => legacyCopyText(text));
      }
      return Promise.resolve(legacyCopyText(text));
    }

    /* Fallback para contextos sin Clipboard API (p. ej. file://). */
    function legacyCopyText(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      if (!ok) throw new Error("el navegador no permitió copiar");
    }

    function flashButton(btn, label) {
      var labelEl = btn.querySelector(".btn-label") || btn;
      var orig = labelEl.textContent;
      btn.classList.add("is-ok");
      labelEl.textContent = "✓ " + label;
      setTimeout(() => {
        btn.classList.remove("is-ok");
        labelEl.textContent = orig;
      }, 1600);
    }

    /* ----- acciones de exportación ----- */

    $("copyBtn").addEventListener("click", function () {
      if (!ensureExportSource()) return;
      copyText(currentRows().join("\n"))
        .then(() => {
          flashButton(this, "Copiado");
          setStatus("TXT COPIADO", "ok");
        })
        .catch((err) => {
          setStatus(
            "ERROR — " + (err && err.message ? err.message : err),
            "error",
          );
        });
    });

    $("downloadBtn").addEventListener("click", () => {
      if (!ensureExportSource()) return;
      downloadBlob(
        currentRows().join("\n") + "\n",
        "dots-ascii.txt",
        "text/plain;charset=utf-8",
      );
      setStatus("TXT EXPORTADO · dots-ascii.txt", "ok");
    });

    $("svgBtn").addEventListener("click", () => {
      if (!ensureExportSource()) return;
      var svg = buildSvgOutput(currentRows(), effectiveColor());
      downloadBlob(svg, "dots-ascii.svg", "image/svg+xml;charset=utf-8");
      setStatus("SVG EXPORTADO · dots-ascii.svg", "ok");
    });

    $("ansiBtn").addEventListener("click", () => {
      if (!ensureExportSource()) return;
      var ansi = buildAnsiOutput(currentRows(), effectiveColor());
      downloadBlob(ansi, "dots-ascii.ans", "text/plain;charset=utf-8");
      setStatus("ANSI EXPORTADO · dots-ascii.ans", "ok");
    });

    $("copyAnsiBtn").addEventListener("click", function () {
      if (!ensureExportSource()) return;
      var ansi = buildAnsiOutput(currentRows(), effectiveColor());
      copyText(ansi)
        .then(() => {
          flashButton(this, "Copiado");
          setStatus("ANSI COPIADO — pegalo en una terminal", "ok");
        })
        .catch((err) => {
          setStatus(
            "ERROR — " + (err && err.message ? err.message : err),
            "error",
          );
        });
    });

    /* ----- GIF animado (gif.js local, todos los efectos) ----- */

    downloadGifBtn.addEventListener("click", function () {
      if (typeof GIF === "undefined") {
        setStatus(
          "ERROR — la librería gif.js local no está disponible",
          "error",
        );
        return;
      }
      if (!luminanceGrid || !luminanceGrid.length) {
        setStatus(
          "ERROR — cargá una imagen o capturá un fotograma primero",
          "error",
        );
        return;
      }
      var labelEl = this.querySelector(".btn-label") || this;
      var origLabel = labelEl.textContent;
      this.disabled = true;
      labelEl.textContent = "Generando…";
      setStatus("EXPORTANDO GIF…", "busy");

      exportGif()
        .then(() => {
          setStatus("GIF LISTO · dots-ascii.gif", "ok");
        })
        .catch((err) => {
          console.error("Error generando GIF:", err);
          setStatus(
            "ERROR — " + (err && err.message ? err.message : err),
            "error",
          );
        })
        .finally(() => {
          /* El reset SIEMPRE corre, incluso si algo explota a mitad de
           camino (bug de v1: el botón quedaba en "Generando…"). */
          this.disabled = false;
          labelEl.textContent = origLabel;
        });
    });

    function exportGif() {
      var p = readParams();
      var fs = p.fontSize;
      var width = Math.max(1, Math.round(gridWidth * fs * 0.6));
      var height = Math.max(1, Math.round(gridHeight * fs));

      var gifCanvas = document.createElement("canvas");
      gifCanvas.width = width;
      gifCanvas.height = height;
      var gifCtx = gifCanvas.getContext("2d", { willReadFrequently: true });

      var fps = 10;
      var duration = 2;
      var framesCount = fps * duration;

      var gif = new GIF({
        workers: 2,
        quality: 20,
        width: width,
        height: height,
        workerScript: "assets/vendor/gif.worker.js",
      });

      var drops = createRainDrops(gridWidth, gridHeight);
      var mode = p.effect === "off" ? "wave" : p.effect;

      for (var i = 0; i < framesCount; i++) {
        var tMs = (i / fps) * 1000;
        var ascii = computeFrame(
          luminanceGrid,
          gridWidth,
          gridHeight,
          mode,
          tMs,
          {
            density: p.density,
            inverted: p.inverted,
            speed: p.speed,
            drops: drops,
          },
        );

        gifCtx.fillStyle = OUTPUT_BG;
        gifCtx.fillRect(0, 0, width, height);

        if (p.color.kind === "gradient") {
          var grad = gifCtx.createLinearGradient(0, 0, width, height);
          p.color.stops.forEach((hex, si) => {
            grad.addColorStop(si / (p.color.stops.length - 1), hex);
          });
          gifCtx.fillStyle = grad;
        } else if (p.color.kind === "solid") {
          gifCtx.fillStyle = p.color.hex;
        } else {
          gifCtx.fillStyle = MONO_FILL;
        }

        gifCtx.font = fs + "px 'Courier New', monospace";
        gifCtx.textBaseline = "top";

        var lines = ascii.split("\n");
        for (var y = 0; y < lines.length; y++) {
          var line = lines[y];
          for (var x = 0; x < line.length; x++) {
            gifCtx.fillText(line[x], x * fs * 0.6, y * fs);
          }
        }

        gif.addFrame(gifCtx, { copy: true, delay: 1000 / fps });
      }

      return new Promise((resolve, reject) => {
        gif.on("finished", (blob) => {
          downloadBlob(blob, "dots-ascii.gif", "image/gif");
          resolve();
        });
        gif.on("error", (err) => {
          reject(err);
        });
        gif.render();
      });
    }

    /* ----- modal de código para incrustar ----- */

    var embedModal = $("embedModal");
    var staticCodeEl = $("staticCode");
    var animatedCodeEl = $("animatedCode");
    var lastFocus = null;

    function openEmbedModal() {
      if (!ensureExportSource()) return;
      var p = readParams();
      staticCodeEl.textContent = generateStaticCode(
        currentAscii,
        p.color,
        p.fontSize,
      );
      animatedCodeEl.textContent = generateAnimatedCode(
        luminanceGrid,
        gridWidth,
        gridHeight,
        p.color,
        p.fontSize,
        p.effect,
        animSpeedSlider.value,
        p.density,
        p.inverted,
      );
      lastFocus = document.activeElement;
      embedModal.classList.add("active");
      $("modalClose").focus();
    }

    function closeEmbedModal() {
      embedModal.classList.remove("active");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    $("embedBtn").addEventListener("click", openEmbedModal);
    $("modalClose").addEventListener("click", closeEmbedModal);

    embedModal.addEventListener("click", (e) => {
      if (e.target === embedModal) closeEmbedModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && embedModal.classList.contains("active"))
        closeEmbedModal();
    });

    Array.prototype.forEach.call(
      document.querySelectorAll(".code-tab"),
      (tab) => {
        tab.addEventListener("click", () => {
          Array.prototype.forEach.call(
            document.querySelectorAll(".code-tab"),
            (t) => {
              t.classList.remove("active");
            },
          );
          Array.prototype.forEach.call(
            document.querySelectorAll(".code-panel"),
            (pn) => {
              pn.classList.remove("active");
            },
          );
          tab.classList.add("active");
          $("panel-" + tab.dataset.tab).classList.add("active");
        });
      },
    );

    Array.prototype.forEach.call(
      document.querySelectorAll(".code-copy-btn"),
      (btn) => {
        btn.addEventListener("click", () => {
          var target =
            btn.dataset.copy === "static" ? staticCodeEl : animatedCodeEl;
          copyText(target.textContent)
            .then(() => {
              btn.textContent = "✓ Copiado";
              btn.classList.add("is-ok");
              setTimeout(() => {
                btn.textContent = "Copiar";
                btn.classList.remove("is-ok");
              }, 1500);
            })
            .catch((err) => {
              setStatus(
                "ERROR — " + (err && err.message ? err.message : err),
                "error",
              );
            });
        });
      },
    );

    setStatus("LISTO", "ready");

    updateCameraUi();
    if (!cameraSupported) {
      camStartBtn.title = "se requiere HTTPS";
      dzCamBtn.title = "se requiere HTTPS";
      setStatus("CÁMARA NO DISPONIBLE (SE REQUIERE HTTPS)", "warn");
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();

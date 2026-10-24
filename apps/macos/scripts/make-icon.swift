// Renders the app icon set from brand/app-icon.svg onto the macOS icon grid (824 px tile on a
// 1024 canvas, soft shadow). AppKit's SVG renderer ignores stroke-opacity, so feed it a copy with
// element opacity instead:
//   sed -E 's/stroke-opacity="([0-9.]+)"/opacity="\1"/g' brand/app-icon.svg > /tmp/icon.svg
//   swift apps/macos/scripts/make-icon.swift /tmp/icon.svg apps/macos/RippleMac/Assets.xcassets/AppIcon.appiconset
import AppKit
let args = CommandLine.arguments
let svg = URL(fileURLWithPath: args[1]); let outDir = URL(fileURLWithPath: args[2])
guard let image = NSImage(contentsOf: svg) else { fatalError("cannot load svg") }
// macOS icon grid: 824 px tile centred on a 1024 canvas.
for (name, px) in [("icon_16", 16), ("icon_32", 32), ("icon_64", 64), ("icon_128", 128), ("icon_256", 256), ("icon_512", 512), ("icon_1024", 1024)] {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current?.imageInterpolation = .high
  let tile = CGFloat(px) * 824 / 1024, inset = (CGFloat(px) - tile) / 2
  // Soft drop shadow under the tile, as the system icon grid expects.
  let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.28); shadow.shadowBlurRadius = CGFloat(px) * 10 / 1024; shadow.shadowOffset = NSSize(width: 0, height: -CGFloat(px) * 6 / 1024); shadow.set()
  image.draw(in: NSRect(x: inset, y: inset, width: tile, height: tile), from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent("\(name).png"))
}
print("ok")

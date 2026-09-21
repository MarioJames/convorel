# 生成提示词

本套素材使用内置 `image_gen` 生成及编辑，未使用 CLI/API fallback。多尺寸 PNG 与 ICO 由最终母版等比例缩小导出，保留原始 Alpha 通道；未使用代码绘制或抠图替代 imagegen。

原始身份参考为仓库的 `docs/assets/convorel-mark.png`。后续图形与字标均引用前一步已选定的母版。浅色字标透明尝试出现杂点，未纳入交付；深色页面使用深色底白字组合或透明独立图标。

## convorel-mark-transparent

```text
Use case: logo-brand
Asset type: Convorel primary app icon / transparent master PNG, square, ideally 1024x1024 or larger.
Input images: Image 1 is the current Convorel mark, the identity reference to simplify, not a background to keep.
Primary request: Make a precise, beautiful flat production-logo counterpart of this two-ribbon open C. Preserve the recognizable open-right C silhouette, two independent broad arcs, the upper cobalt-blue ribbon and lower sea-glass ribbon, the diagonal white/transparent separation and generous central negative space. Simplify the folds to a clean 2D silhouette with crisp gently rounded endpoints so it reads at 24px. Use ONLY two solid brand colors, #3458DB upper arc and #7CB8BE lower arc. No gradients, no 3D, no texture, no shadows. Keep the full mark centered in a square with about 15% clear margin each side. True alpha-transparent background, including the center and the separation, not a checkerboard painting. No text, no border, no tile, no mockup, no extra shapes. Produce one finished standalone icon.
```

## convorel-mark-light

```text
Use case: precise-object-edit
Asset type: Convorel square avatar logo on a light background.
Input images: Image 1 is the edit target, the approved transparent icon.
Change only the transparent background to a uniform opaque solid mist-white #F5F8FB. Preserve the icon's exact geometry, position, scale, two colors, open C silhouette, and all whitespace. Keep square 1:1 framing. No added shadow, texture, lighting, outline, letters, or decoration. Single production asset.
```

## convorel-mark-dark

```text
Use case: precise-object-edit
Asset type: Convorel square avatar logo on a dark background.
Input images: Image 1 is the edit target, the approved transparent icon.
Change only the transparent background to a uniform opaque solid deep navy #14263D. Preserve the icon's exact geometry, position, scale, two colors, open C silhouette, and all whitespace. Keep square 1:1 framing. No added shadow, texture, lighting, outline, letters, or decoration. Single production asset.
```

## convorel-lockup-transparent

```text
Use case: logo-brand
Asset type: Convorel horizontal logo lockup, master PNG, wide 3:1 canvas, ideally 1536x512.
Input images: Image 1 is the final primary Convorel symbol. Preserve its two shapes and colors exactly; do not redesign the symbol.
Primary request: Create one refined horizontal logo combining this symbol on the left and the exact word "Convorel" on the right. Spell C-o-n-v-o-r-e-l, capital C only. Wordmark in deep navy #14263D, bold modern geometric sans serif, carefully spaced, no texture or shading. Symbol in cobalt #3458DB and sea-glass #7CB8BE. Icon height about 1.35 times the capital-letter height, both optically centered on one horizontal axis, generous but coherent gap. Lockup occupies about 84% of the width; sufficient padding, no clipping. TRUE transparent alpha background, including all counters and spaces. No shadows, gradients, slogan, annotations, border, mockup or extra elements. Clean flat production artwork.
```

## convorel-lockup-light

```text
Use case: precise-object-edit
Asset type: Convorel horizontal logo with opaque light background.
Input images: Image 1 is the approved horizontal lockup to edit.
Change ONLY the transparent background to uniform opaque mist-white #F5F8FB. Preserve the exact wording "Convorel", deep navy typography, character shapes, two-color mark, all sizing, spacing, positions, and wide aspect ratio. No added text, shadows, texture, decorations or framing. One standalone production logo.
```

## convorel-lockup-dark

```text
Use case: precise-object-edit
Asset type: Convorel horizontal logo with opaque dark background.
Input images: Image 1 is the approved horizontal lockup to edit.
Change the transparent background to uniform opaque deep navy #14263D and change ONLY the wordmark's navy fill to mist-white #F5F8FB so it is clearly legible. Keep the blue and sea-glass icon, exact wording "Convorel", character shapes, all sizing, spacing, positions, and wide aspect ratio. No added text, shadows, texture, decorations or framing. One standalone production logo.
```

## convorel-cover

```text
Use case: ads-marketing
Asset type: Convorel brand cover / social sharing banner, landscape 2:1, high resolution.
Input images: Image 1 is the approved flat icon reference, preserve the two-ribbon C identity. Image 2 is the approved wordmark reference, preserve exact spelling and typography.
Primary request: Create a beautifully restrained developer-tool brand cover. Opaque mist-white #F5F8FB background, deep navy #14263D typography, cobalt #3458DB and sea-glass #7CB8BE accents. Large exact wordmark "Convorel" at the left, beneath it the exact Chinese tagline "让代码协作，多一个独立视角。" in a clean readable Chinese sans serif. At the right, one large sculptural two-ribbon open C matching Image 1, rendered as refined matte folded material, a restrained dimensional interpretation of the flat logo, with soft studio illumination. Keep typography perfectly flat and crisp, generous margins and whitespace. Balanced editorial composition with a subtle horizon-free ground shadow only beneath the sculptural icon. No UI mockups, extra text, symbols, borders, watermarks, or other brand logos. Spell C-o-n-v-o-r-e-l precisely; Chinese sentence exactly as given.
```

# Test fixtures — garment photographs

18 photographs used to measure category-tagging accuracy (TC-04) and dominant-colour
extraction (TC-05). Sourced from Unsplash, whose licence permits free use including
commercially, without permission or attribution — attribution is recorded here anyway
so the provenance of the accuracy figure is auditable.

Chosen deliberately to be a FAIR test rather than a flattering one: several are worn by
people against busy backgrounds, which violates the submitted document's stated assumption
that 'uploaded clothing images have a relatively clean background'.

| file | label | source |
| --- | --- | --- |
| `tshirt-0.jpg` | tshirt | https://unsplash.com/photos/1529374255404-311a2a4f1fd9 |
| `tshirt-1.jpg` | tshirt | https://unsplash.com/photos/1759572095317-3a96f9a98e2b |
| `tshirt-2.jpg` | tshirt | https://unsplash.com/photos/1621951767587-b24334f11c65 |
| `shirt-1.jpg` | shirt | https://unsplash.com/photos/1603252109303-2751441dd157 |
| `shirt-2.jpg` | shirt | https://unsplash.com/photos/1621773881532-fe65715b5137 |
| `trousers-0.jpg` | trousers | https://unsplash.com/photos/1602293589930-45aad59ba3ab |
| `trousers-1.jpg` | trousers | https://unsplash.com/photos/1542272604-787c3835535d |
| `trousers-2.jpg` | trousers | https://unsplash.com/photos/1637069585336-827b298fe84a |
| `jacket-0.jpg` | jacket | https://unsplash.com/photos/1727515546577-f7d82a47b51d |
| `jacket-1.jpg` | jacket | https://unsplash.com/photos/1624548140129-74786c5f1279 |
| `jacket-2.jpg` | jacket | https://unsplash.com/photos/1578198576866-7e0ba6078128 |
| `shoes-0.jpg` | shoes | https://unsplash.com/photos/1560769629-975ec94e6a86 |
| `shoes-1.jpg` | shoes | https://unsplash.com/photos/1608231387042-66d1773070a5 |
| `shoes-2.jpg` | shoes | https://unsplash.com/photos/1600185365926-3a2ce3cdb9eb |
| `dress-0.jpg` | dress | https://unsplash.com/photos/1496747611176-843222e1e57c |
| `dress-1.jpg` | dress | https://unsplash.com/photos/1599309329365-0a9ed45a1da3 |
| `dress-2.jpg` | dress | https://unsplash.com/photos/1542295669297-4d352b042bca |
| `tshirt-3.jpg` | tshirt | originally downloaded as a dress shirt; relabelled after visual inspection — it is a short-sleeve knit tee, and leaving the wrong label would have corrupted the accuracy measurement |

## Measured baseline

`ViT-B-32-quickgelu` / `openai` weights, zero-shot: **17/18 = 94.4%** category accuracy.
The single miss is `tshirt-1.jpg`, a folded flat-lay predicted `shirt` at 0.72 confidence —
folding removes the silhouette the model relies on.

Sample size is 18. That is enough to show the ~80% claim is met, not enough for a tight
confidence interval; Stage 9 should widen it if a precise figure is wanted.

## `exif/` — EXIF-rotation regression fixtures (not part of the 18 above)

Three files, each derived from one of the 18 fixtures above (not separately sourced —
same licensed content, no new external images):

| file | derived from | how |
| --- | --- | --- |
| `exif/dress-0-orientation6.jpg` | `dress-0.jpg` | pixels rotated 90° CCW, tagged EXIF orientation=6 |
| `exif/dress-1-orientation6.jpg` | `dress-1.jpg` | pixels rotated 90° CCW, tagged EXIF orientation=6 |
| `exif/tshirt-3-orientation6.jpg` | `tshirt-3.jpg` | pixels rotated 90° CCW, tagged EXIF orientation=6 |

Orientation 6 is the tag a phone held in portrait actually writes (landscape sensor
data plus "rotate 90° CW to view correctly"). `ImageOps.exif_transpose` undoes this by
rotating 90° CW, which — verified pixel-for-pixel (mean abs diff <1/255, i.e. only
JPEG re-encoding noise) — exactly reproduces the upright original.

These three were chosen because they are exactly the fixtures measured to flip category
when rotation is left uncorrected: `dress-1` (dress→shirt) and `tshirt-3` (tshirt→other)
flip outright; `dress-0` keeps its category but loses substantial confidence (0.81→0.50).
Across the full 18-fixture set, uncorrected rotation drops accuracy from 94.4% to 77.8%
— below the documented ~80% claim — which is why `classify()` now applies
`ImageOps.exif_transpose` before preprocessing.

Deliberately kept in a subdirectory, not next to the 18 above: `tests/test_classifier.py`'s
`fixture_files()` glob is non-recursive (`FIXTURES/*.jpg`), so these are excluded from the
main accuracy measurement and covered by their own dedicated pairwise test instead —
adding them to the accuracy denominator would conflate "does the model recognise the
garment" with "did we remember to correct orientation," which are different failure modes.

# Third-party icons

The operating-system pictograms on the system device objects are the same open-source
icons the Beszel web UI uses (`internal/site/src/components/ui/icons.tsx`). They are
embedded unchanged apart from a `transform` that maps their original viewBox onto the
adapter's 64 × 64 grid.

| File          | Icon                | Source                                                               | License               |
| ------------- | ------------------- | -------------------------------------------------------------------- | --------------------- |
| `linux.svg`   | `linux-logo-bold`   | Phosphor Icons — https://github.com/phosphor-icons/core              | MIT                   |
| `macos.svg`   | `apple`             | teenyicons — https://github.com/teenyicons/teenyicons                | MIT                   |
| `windows.svg` | `windows`           | IconPark — https://github.com/bytedance/IconPark                     | Apache-2.0            |
| `freebsd.svg` | `freebsd`           | Material Design Icons — https://github.com/Templarian/MaterialDesign | Apache-2.0            |
| `server.svg`  | generic server rack | drawn for this adapter                                               | MIT (adapter license) |

## MIT License (Phosphor Icons, teenyicons)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Copyright (c) 2023 Phosphor Icons · Copyright (c) 2020, Anja van Staden (teenyicons)

## Apache License 2.0 (IconPark, Material Design Icons)

IconPark: Copyright ByteDance. Material Design Icons: released by the Pictogrammers icon group under the Pictogrammers Free License, icons under Apache 2.0.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files
except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the
License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied. See the License for the specific language governing permissions
and limitations under the License.

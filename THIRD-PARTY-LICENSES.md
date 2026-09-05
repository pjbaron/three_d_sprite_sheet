# Third-party licences

The MIT licence in `LICENSE` covers the code in this repository. The vendored
libraries in `lib/` are covered by their own licences, reproduced or referenced
below. Model files are not distributed with this repository - see
`models/README.md`.

## Babylon.js 8 - Apache License 2.0

`lib/babylon.js`, `lib/babylonjs.loaders.min.js`, `lib/environmentSpecular.env`

    Copyright (c) Microsoft Corporation and Babylon.js contributors

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use these files except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

Source: https://github.com/BabylonJS/Babylon.js

## Google Draco - Apache License 2.0

`lib/draco_decoder_gltf.wasm`, `lib/draco_wasm_wrapper_gltf.js`

    Copyright 2017 The Draco Authors

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use these files except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

Source: https://github.com/google/draco

## meshoptimizer (meshopt decoder) 0.20 - MIT License

`lib/meshopt_decoder.js`

    Copyright (c) 2016-2024 Arseny Kapoulkine

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

Source: https://github.com/zeux/meshoptimizer

## Model assets - not included

The `.glb` files under `models/` are excluded from this repository. They derive
from Adobe Mixamo and Meshy AI, whose terms do not permit redistributing the
source files. Supply your own models to run the tool.

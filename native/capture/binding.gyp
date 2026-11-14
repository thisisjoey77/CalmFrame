{
  "targets": [
    {
      "target_name": "calmframe_capture",
      "sources": ["src/capture.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": ["d3d11.lib", "dxgi.lib", "winmm.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/W3"],
          "ExceptionHandling": 1
        }
      }
    }
  ]
}

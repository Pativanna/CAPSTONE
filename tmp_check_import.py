import importlib
v = importlib.import_module('parts.views')
print('Imported parts.views OK')
print('Has extract_vehicle_info_local:', hasattr(v, 'extract_vehicle_info_local'))
print('Has transcribe_with_python_whisper in module dict:', 'transcribe_with_python_whisper' in v.__dict__)

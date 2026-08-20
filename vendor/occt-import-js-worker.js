importScripts('occt-import-js.js');

onmessage = async function (ev) {
	let moduleOverrides = {
		locateFile: function (path) {
			return path;
		}
	};
	let occt = await occtimportjs(moduleOverrides);
	let result = occt.ReadFile(ev.data.format, ev.data.buffer, ev.data.params);
	postMessage(result);
};

// CommonJS re-export of the marketOptions service
const { generateOptions, identifyCorrectOption } = require('../services/marketOptions');
module.exports = { generateOptions, identifyCorrectOption };

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QuickChart = require('quickchart-js');
const { Parser } = require('json2csv');

const User = require('./models/User');
const Food = require('./models/Food');
const Exercise = require('./models/Exercise');
const FrequentMeal = require('./models/FrequentMeal');
const Weight = require('./models/Weight');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const userStates = {};

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => console.error('❌ Error MongoDB:', err));


function getStartOfDay(date = new Date()) {
  const d = new Date(date);
  // Convert to Argentina timezone (UTC-3)
  const offset = -3 * 60 * 60 * 1000; // -3 hours in milliseconds
  const localTime = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + offset);
  localTime.setHours(0, 0, 0, 0);
  // Convert back to UTC for MongoDB query
  return new Date(localTime.getTime() - offset - d.getTimezoneOffset() * 60000);
}

function getEndOfDay(date = new Date()) {
  const d = new Date(date);
  // Convert to Argentina timezone (UTC-3)
  const offset = -3 * 60 * 60 * 1000; // -3 hours in milliseconds
  const localTime = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + offset);
  localTime.setHours(23, 59, 59, 999);
  // Convert back to UTC for MongoDB query
  return new Date(localTime.getTime() - offset - d.getTimezoneOffset() * 60000);
}

function getMetaDelDia(user) {
  if (!user) return 2000;
  if (user.planFinde && user.metaCaloriasLV && user.metaCaloriasFinde) {
    const dia = new Date().getDay();
    return (dia === 0 || dia === 6) ? user.metaCaloriasFinde : user.metaCaloriasLV;
  }
  return user.metaCalorias || 2000;
}

async function analyzeImageWithGemini(imageBuffer, text = '') {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Analiza esta imagen de comida${text ? ` (contexto adicional: ${text})` : ''}.
    Responde SOLO con un JSON válido con este formato exacto:
    {
      "nombre": "nombre del alimento",
      "calorias": número,
      "proteinas": número en gramos,
      "carbohidratos": número en gramos,
      "grasas": número en gramos,
      "cantidad": "porción estimada"
    }
    Si hay varios alimentos, suma los valores totales.
    No incluyas texto adicional, solo el JSON.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBuffer.toString('base64')
        }
      }
    ]);

    const response = await result.response;
    let responseText = response.text();
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error Gemini:', error);
    return null;
  }
}

async function analyzeTextWithGemini(text) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Analiza esta descripción de comida: "${text}".
    Responde SOLO con un JSON válido con este formato exacto:
    {
      "nombre": "nombre del alimento",
      "calorias": número,
      "proteinas": número en gramos,
      "carbohidratos": número en gramos,
      "grasas": número en gramos,
      "cantidad": "porción estimada"
    }
    Si hay varios alimentos, suma los valores totales.
    No incluyas texto adicional, solo el JSON.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let responseText = response.text();
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error Gemini texto:', error);
    return null;
  }
}

async function consultWithGemini(text) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `Analiza esta descripción de comida: "${text}".
    Responde SOLO con un JSON válido con este formato exacto:
    {
      "nombre": "nombre del alimento",
      "calorias": número,
      "proteinas": número en gramos,
      "carbohidratos": número en gramos,
      "grasas": número en gramos,
      "cantidad": "porción estimada"
    }
    No incluyas texto adicional, solo el JSON.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let responseText = response.text();
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error Gemini consulta:', error);
    return null;
  }
}

async function getTodayStats(telegramId) {
  const start = getStartOfDay();
  const end = getEndOfDay();

  const foods = await Food.find({
    telegramId,
    fecha: { $gte: start, $lte: end }
  });

  const exercises = await Exercise.find({
    telegramId,
    fecha: { $gte: start, $lte: end }
  });

  const totalCalorias = foods.reduce((sum, f) => sum + (f.calorias || 0), 0);
  const totalProteinas = foods.reduce((sum, f) => sum + (f.proteinas || 0), 0);
  const totalCarbohidratos = foods.reduce((sum, f) => sum + (f.carbohidratos || 0), 0);
  const totalGrasas = foods.reduce((sum, f) => sum + (f.grasas || 0), 0);
  const caloriasQuemadas = exercises.reduce((sum, e) => sum + (e.caloriasQuemadas || 0), 0);

  return {
    calorias: totalCalorias,
    proteinas: totalProteinas,
    carbohidratos: totalCarbohidratos,
    grasas: totalGrasas,
    caloriasQuemadas,
    caloriasNetas: totalCalorias - caloriasQuemadas,
    comidas: foods,
    ejercicios: exercises
  };
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ telegramId: chatId });

  if (!user) {
    await User.create({
      telegramId: chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  await bot.sendMessage(chatId, `🍎 ¡Bienvenido a CalCounter!

Soy tu asistente para contar calorías. Puedes:
📸 Enviarme una foto de tu comida
✍️ Escribir qué comiste

Comandos disponibles:
/config - Configurar datos iniciales
/calorias - Ver kcal de hoy
/macros - Ver macros del día
/resumen - Balance completo del día
/consultar - Consultar kcal sin registrar
/sugerencia - Sugerencia de comida con IA
/historial - Ver días anteriores
/semana - Estadísticas semanales con gráfico
/metas - Ver/configurar metas
/peso - Registrar peso
/ejercicio - Añadir actividad física
/borrarejercicio - Eliminar último ejercicio
/guardar - Guardar comida frecuente
/frecuentes - Ver comidas guardadas
/eliminarfav - Borrar comida frecuente
/exportar - Exportar datos a CSV`);
});

bot.onText(/\/config/, async (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'config_peso' };
  await bot.sendMessage(chatId, '⚙️ Vamos a configurar tus datos.\n\n¿Cuál es tu peso actual en kg?');
});

bot.onText(/\/metas/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ telegramId: chatId });

  if (!user || !user.metaCalorias) {
    userStates[chatId] = { step: 'metas_calorias' };
    await bot.sendMessage(chatId, '🎯 Configuremos tus metas diarias.\n\n¿Cuántas calorías quieres consumir por día?');
  } else {
    await bot.sendMessage(chatId, `🎯 *Tus metas actuales:*

🔥 Calorías: ${user.metaCalorias} kcal
🥩 Proteínas: ${user.metaProteinas || 0}g
🍞 Carbohidratos: ${user.metaCarbohidratos || 0}g
🧈 Grasas: ${user.metaGrasas || 0}g

¿Quieres modificarlas? Escribe /config para reconfigurar.`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/calorias/, async (msg) => {
  const chatId = msg.chat.id;
  const stats = await getTodayStats(chatId);
  const user = await User.findOne({ telegramId: chatId });
  const meta = getMetaDelDia(user);
  const restantes = meta - stats.caloriasNetas;

  const dia = new Date().getDay();
  const tipoDia = (user?.planFinde && user.metaCaloriasLV && user.metaCaloriasFinde)
    ? ((dia === 0 || dia === 6) ? ' (fin de semana)' : ' (L-V)')
    : '';

  await bot.sendMessage(chatId, `🔥 *Calorías de hoy:*

📥 Consumidas: ${stats.calorias} kcal
🏃 Quemadas: ${stats.caloriasQuemadas} kcal
📊 Netas: ${stats.caloriasNetas} kcal

🎯 Meta: ${meta} kcal${tipoDia}
${restantes > 0 ? `✅ Te quedan: ${restantes} kcal` : `⚠️ Excedido por: ${Math.abs(restantes)} kcal`}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/macros/, async (msg) => {
  const chatId = msg.chat.id;
  const stats = await getTodayStats(chatId);
  const user = await User.findOne({ telegramId: chatId });

  const metaCal = getMetaDelDia(user);
  await bot.sendMessage(chatId, `📊 *Macros de hoy:*

🔥 Calorías: ${stats.calorias} / ${metaCal} kcal
🥩 Proteínas: ${stats.proteinas.toFixed(1)}g ${user?.metaProteinas ? `/ ${user.metaProteinas}g` : ''}
🍞 Carbohidratos: ${stats.carbohidratos.toFixed(1)}g ${user?.metaCarbohidratos ? `/ ${user.metaCarbohidratos}g` : ''}
🧈 Grasas: ${stats.grasas.toFixed(1)}g ${user?.metaGrasas ? `/ ${user.metaGrasas}g` : ''}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/resumen/, async (msg) => {
  const chatId = msg.chat.id;
  const stats = await getTodayStats(chatId);
  const user = await User.findOne({ telegramId: chatId });
  const meta = getMetaDelDia(user);

  const dia = new Date().getDay();
  const tipoDia = (user?.planFinde && user.metaCaloriasLV && user.metaCaloriasFinde)
    ? ((dia === 0 || dia === 6) ? ' (fin de semana)' : ' (L-V)')
    : '';

  let comidasText = stats.comidas.length > 0
    ? stats.comidas.map(c => `  • ${c.nombre}: ${c.calorias} kcal`).join('\n')
    : '  No hay registros';

  let ejerciciosText = stats.ejercicios.length > 0
    ? stats.ejercicios.map(e => `  • ${e.nombre}: -${e.caloriasQuemadas} kcal`).join('\n')
    : '  No hay registros';

  await bot.sendMessage(chatId, `📋 *Resumen del día:*

🍽️ *Comidas:*
${comidasText}

🏃 *Ejercicios:*
${ejerciciosText}

━━━━━━━━━━━━━━━
🔥 Total consumido: ${stats.calorias} kcal
🏃 Total quemado: ${stats.caloriasQuemadas} kcal
📊 Balance neto: ${stats.caloriasNetas} kcal

📊 *Macros:*
🥩 Proteínas: ${stats.proteinas.toFixed(1)}g
🍞 Carbohidratos: ${stats.carbohidratos.toFixed(1)}g
🧈 Grasas: ${stats.grasas.toFixed(1)}g

🎯 Meta: ${meta} kcal${tipoDia} | ${meta - stats.caloriasNetas > 0 ? `Restante: ${meta - stats.caloriasNetas}` : `Excedido: ${Math.abs(meta - stats.caloriasNetas)}`} kcal`, { parse_mode: 'Markdown' });
});

bot.onText(/\/consultar (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const texto = match[1];

  await bot.sendMessage(chatId, '🔍 Analizando...');

  const resultado = await consultWithGemini(texto);

  if (resultado) {
    await bot.sendMessage(chatId, `📊 *Información nutricional de "${resultado.nombre}":*

🔥 Calorías: ${resultado.calorias} kcal
🥩 Proteínas: ${resultado.proteinas}g
🍞 Carbohidratos: ${resultado.carbohidratos}g
🧈 Grasas: ${resultado.grasas}g
📏 Porción: ${resultado.cantidad}

_Este es solo una consulta, no se ha registrado._`, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, '❌ No pude analizar esa comida. Intenta ser más específico.');
  }
});

bot.onText(/\/consultar$/, async (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'consultar' };
  await bot.sendMessage(chatId, '🔍 ¿Qué comida quieres consultar? (no se registrará)');
});

bot.onText(/\/historial/, async (msg) => {
  const chatId = msg.chat.id;
  const dias = 7;
  const resultados = [];

  for (let i = 0; i < dias; i++) {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - i);
    const start = getStartOfDay(fecha);
    const end = getEndOfDay(fecha);

    const foods = await Food.find({
      telegramId: chatId,
      fecha: { $gte: start, $lte: end }
    });

    const exercises = await Exercise.find({
      telegramId: chatId,
      fecha: { $gte: start, $lte: end }
    });

    const calorias = foods.reduce((sum, f) => sum + (f.calorias || 0), 0);
    const quemadas = exercises.reduce((sum, e) => sum + (e.caloriasQuemadas || 0), 0);

    resultados.push({
      fecha: fecha.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }),
      calorias,
      quemadas,
      netas: calorias - quemadas
    });
  }

  let texto = '📅 *Historial de los últimos 7 días:*\n\n';
  resultados.forEach(r => {
    texto += `📆 ${r.fecha}: ${r.calorias} kcal (🏃-${r.quemadas}) = ${r.netas} netas\n`;
  });

  await bot.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
});

bot.onText(/\/semana/, async (msg) => {
  const chatId = msg.chat.id;
  const dias = 7;
  const labels = [];
  const dataCalorias = [];
  const dataQuemadas = [];

  for (let i = 6; i >= 0; i--) {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - i);
    const start = getStartOfDay(fecha);
    const end = getEndOfDay(fecha);

    const foods = await Food.find({
      telegramId: chatId,
      fecha: { $gte: start, $lte: end }
    });

    const exercises = await Exercise.find({
      telegramId: chatId,
      fecha: { $gte: start, $lte: end }
    });

    labels.push(fecha.toLocaleDateString('es-ES', { weekday: 'short' }));
    dataCalorias.push(foods.reduce((sum, f) => sum + (f.calorias || 0), 0));
    dataQuemadas.push(exercises.reduce((sum, e) => sum + (e.caloriasQuemadas || 0), 0));
  }

  const chart = new QuickChart();
  chart.setConfig({
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Calorías consumidas',
          data: dataCalorias,
          backgroundColor: 'rgba(255, 99, 132, 0.8)',
        },
        {
          label: 'Calorías quemadas',
          data: dataQuemadas,
          backgroundColor: 'rgba(54, 162, 235, 0.8)',
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Estadísticas de la semana'
        }
      }
    }
  });
  chart.setWidth(800);
  chart.setHeight(400);
  chart.setBackgroundColor('white');

  const imageBuffer = await chart.toBinary();
  
  const promedio = dataCalorias.reduce((a, b) => a + b, 0) / 7;
  const total = dataCalorias.reduce((a, b) => a + b, 0);

  await bot.sendPhoto(chatId, imageBuffer, {
    caption: `📊 *Estadísticas semanales*\n\n📈 Promedio diario: ${promedio.toFixed(0)} kcal\n📊 Total semana: ${total} kcal\n🏃 Total quemado: ${dataQuemadas.reduce((a, b) => a + b, 0)} kcal`,
    parse_mode: 'Markdown'
  });
});

bot.onText(/\/peso$/, async (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'peso' };
  await bot.sendMessage(chatId, '⚖️ ¿Cuál es tu peso actual en kg?');
});

bot.onText(/\/peso (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const peso = parseFloat(match[1]);

  if (isNaN(peso)) {
    await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
    return;
  }

  await Weight.create({ telegramId: chatId, peso });
  await User.findOneAndUpdate({ telegramId: chatId }, { peso }, { upsert: true });

  const weights = await Weight.find({ telegramId: chatId }).sort({ fecha: -1 }).limit(5);
  let historial = weights.map(w =>
    `${w.fecha.toLocaleDateString('es-ES')}: ${w.peso} kg`
  ).join('\n');

  await bot.sendMessage(chatId, `✅ Peso registrado: ${peso} kg\n\n📊 Últimos registros:\n${historial}\n\n💡 Usa /progreso para ver tu gráfico de evolución`);
});

bot.onText(/\/progreso/, async (msg) => {
  const chatId = msg.chat.id;

  const weights = await Weight.find({ telegramId: chatId }).sort({ fecha: 1 }).limit(30);

  if (weights.length < 2) {
    await bot.sendMessage(chatId, '📊 Necesitas al menos 2 registros de peso para ver tu progreso.\n\nUsa /peso para registrar tu peso.');
    return;
  }

  try {
    const labels = weights.map(w => w.fecha.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }));
    const dataPesos = weights.map(w => w.peso);

    const chart = new QuickChart();
    chart.setConfig({
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Peso (kg)',
          data: dataPesos,
          borderColor: 'rgba(75, 192, 192, 1)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: 'rgba(75, 192, 192, 1)'
        }]
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: 'Progreso de Peso'
          },
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'Peso (kg)'
            }
          }
        }
      }
    });
    chart.setWidth(800);
    chart.setHeight(400);
    chart.setBackgroundColor('white');

    const chartUrl = await chart.getShortUrl();
    console.log('Chart URL generada:', chartUrl);

    const pesoInicial = dataPesos[0];
    const pesoActual = dataPesos[dataPesos.length - 1];
    const diferencia = pesoActual - pesoInicial;
    const tendencia = diferencia < 0 ? '📉 Bajando' : diferencia > 0 ? '📈 Subiendo' : '➡️ Estable';

    await bot.sendPhoto(chatId, chartUrl, {
      caption: `📊 *Tu progreso de peso*\n\n⚖️ Peso inicial: ${pesoInicial} kg\n⚖️ Peso actual: ${pesoActual} kg\n${tendencia}: ${diferencia > 0 ? '+' : ''}${diferencia.toFixed(1)} kg\n📝 Total registros: ${weights.length}`,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error generando gráfico de peso:', error);
    await bot.sendMessage(chatId, '❌ Error al generar el gráfico. Intenta de nuevo.');
  }
});

bot.onText(/\/ejercicio$/, async (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'ejercicio_nombre' };
  await bot.sendMessage(chatId, '🏃 ¿Qué ejercicio realizaste?');
});

bot.onText(/\/ejercicio (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const texto = match[1];
  
  const parts = texto.split(' ');
  if (parts.length >= 2) {
    const calorias = parseInt(parts[parts.length - 1]);
    if (!isNaN(calorias)) {
      const nombre = parts.slice(0, -1).join(' ');
      await Exercise.create({
        telegramId: chatId,
        nombre,
        caloriasQuemadas: calorias
      });
      await bot.sendMessage(chatId, `✅ Ejercicio registrado:\n🏃 ${nombre}: -${calorias} kcal`);
      return;
    }
  }
  
  userStates[chatId] = { step: 'ejercicio_calorias', ejercicioNombre: texto };
  await bot.sendMessage(chatId, `🔥 ¿Cuántas calorías quemaste con "${texto}"?`);
});

bot.onText(/\/borrarejercicio/, async (msg) => {
  const chatId = msg.chat.id;
  const start = getStartOfDay();
  const end = getEndOfDay();

  const lastExercise = await Exercise.findOneAndDelete({
    telegramId: chatId,
    fecha: { $gte: start, $lte: end }
  }).sort({ createdAt: -1 });

  if (lastExercise) {
    await bot.sendMessage(chatId, `🗑️ Ejercicio eliminado:\n${lastExercise.nombre}: -${lastExercise.caloriasQuemadas} kcal`);
  } else {
    await bot.sendMessage(chatId, '❌ No hay ejercicios registrados hoy para eliminar.');
  }
});

bot.onText(/\/guardar/, async (msg) => {
  const chatId = msg.chat.id;
  const start = getStartOfDay();
  const end = getEndOfDay();

  const lastFood = await Food.findOne({
    telegramId: chatId,
    fecha: { $gte: start, $lte: end }
  }).sort({ createdAt: -1 });

  if (lastFood) {
    await FrequentMeal.create({
      telegramId: chatId,
      nombre: lastFood.nombre,
      calorias: lastFood.calorias,
      proteinas: lastFood.proteinas,
      carbohidratos: lastFood.carbohidratos,
      grasas: lastFood.grasas,
      cantidad: lastFood.cantidad
    });
    await bot.sendMessage(chatId, `⭐ Guardado como frecuente:\n${lastFood.nombre} (${lastFood.calorias} kcal)`);
  } else {
    await bot.sendMessage(chatId, '❌ No hay comidas registradas hoy para guardar.');
  }
});

bot.onText(/\/sugerencia/, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, '🤔 Pensando sugerencias para ti...');

  try {
    const stats = await getTodayStats(chatId);
    const user = await User.findOne({ telegramId: chatId });
    const meta = getMetaDelDia(user);
    const restantes = meta - stats.caloriasNetas;

    if (restantes <= 0) {
      await bot.sendMessage(chatId, '⚠️ Ya alcanzaste tu meta de calorías por hoy. ¡Buen trabajo! 🎉');
      return;
    }

    const frecuentes = await FrequentMeal.find({ telegramId: chatId }).limit(10);

    const comidasFrecuentesText = frecuentes.length > 0
      ? frecuentes.map(f => `- ${f.nombre}: ${f.calorias} kcal`).join('\n')
      : 'No tienes comidas frecuentes guardadas.';

    const prompt = `Eres un nutricionista experto. El usuario tiene ${restantes} kcal restantes para completar su meta diaria.

Sus comidas frecuentes son:
${comidasFrecuentesText}

Proporciona UNA sugerencia de comida (desayuno, almuerzo, merienda o cena según corresponda a la hora del día en Argentina, UTC-3).

La sugerencia debe:
1. Caber en las ${restantes} kcal restantes
2. Preferiblemente usar ingredientes similares a sus comidas frecuentes
3. Incluir porciones específicas

Responde SOLO con un JSON válido con este formato exacto (sin markdown, sin backticks, solo el JSON raw):
{"nombre": "nombre del plato", "tipo": "desayuno/almuerzo/merienda/cena", "calorias": 0, "proteinas": 0, "carbohidratos": 0, "grasas": 0, "ingredientes": ["ingrediente 1"], "porcion": "descripción", "consejo": "texto corto"}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    const response = await result.response;

    let responseText = response.text().trim();
    
    // Limpiar posibles markdown que Gemini a veces agrega
    responseText = responseText.replace(/^```[\w]*\n?/gm, '').replace(/```\n?$/gm, '').trim();
    responseText = responseText.replace(/^json\n?/i, '').trim();
    
    console.log('Respuesta cruda de Gemini:', responseText);
    
    const sugerencia = JSON.parse(responseText);

    const esFrecuente = frecuentes.some(f =>
      f.nombre.toLowerCase().includes(sugerencia.nombre.toLowerCase()) ||
      sugerencia.nombre.toLowerCase().includes(f.nombre.toLowerCase())
    );

    const frecuenteBadge = esFrecuente ? ' ⭐ (basado en tus favoritas)' : '';

    await bot.sendMessage(chatId, `💡 *Sugerencia para tu ${sugerencia.tipo}*${frecuenteBadge}

🍽️ *${sugerencia.nombre}*
🔥 ${sugerencia.calorias} kcal | 🥩 ${sugerencia.proteinas}g prot | 🍞 ${sugerencia.carbohidratos}g carb | 🧈 ${sugerencia.grasas}g grasa

📋 *Ingredientes:*
${sugerencia.ingredientes.map(i => `  • ${i}`).join('\n')}

📏 *Porción:* ${sugerencia.porcion}

💬 ${sugerencia.consejo}

${sugerencia.calorias <= restantes ? `✅ Quedarían ${restantes - sugerencia.calorias} kcal disponibles` : '⚠️ Esta sugerencia excede un poco tus calorías restantes'}`, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error en sugerencia:', error);
    await bot.sendMessage(chatId, '❌ No pude generar una sugerencia ahora. Intenta más tarde.');
  }
});

bot.onText(/\/frecuentes/, async (msg) => {
  const chatId = msg.chat.id;
  const frecuentes = await FrequentMeal.find({ telegramId: chatId });

  if (frecuentes.length === 0) {
    await bot.sendMessage(chatId, '📭 No tienes comidas frecuentes guardadas.\nUsa /guardar después de registrar una comida.');
    return;
  }

  const keyboard = frecuentes.map((f, i) => [{
    text: `${f.nombre} (${f.calorias} kcal)`,
    callback_data: `freq_${f._id}`
  }]);

  await bot.sendMessage(chatId, '⭐ *Comidas frecuentes:*\nToca una para registrarla:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/eliminarfav/, async (msg) => {
  const chatId = msg.chat.id;
  const frecuentes = await FrequentMeal.find({ telegramId: chatId });

  if (frecuentes.length === 0) {
    await bot.sendMessage(chatId, '📭 No tienes comidas frecuentes guardadas.');
    return;
  }

  const keyboard = frecuentes.map((f, i) => [{
    text: `🗑️ ${f.nombre}`,
    callback_data: `delfav_${f._id}`
  }]);

  await bot.sendMessage(chatId, '🗑️ *Selecciona la comida a eliminar:*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/exportar/, async (msg) => {
  const chatId = msg.chat.id;
  
  const foods = await Food.find({ telegramId: chatId }).sort({ fecha: -1 });
  
  if (foods.length === 0) {
    await bot.sendMessage(chatId, '📭 No hay datos para exportar.');
    return;
  }

  const data = foods.map(f => ({
    fecha: f.fecha.toLocaleDateString('es-ES'),
    nombre: f.nombre,
    calorias: f.calorias,
    proteinas: f.proteinas,
    carbohidratos: f.carbohidratos,
    grasas: f.grasas,
    cantidad: f.cantidad
  }));

  const parser = new Parser();
  const csv = parser.parse(data);

  await bot.sendDocument(chatId, Buffer.from(csv), {
    filename: 'calcounter_export.csv',
    caption: '📊 Aquí tienes tu historial de comidas exportado.'
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('freq_')) {
    const id = data.replace('freq_', '');
    const frecuente = await FrequentMeal.findById(id);
    
    if (frecuente) {
      await Food.create({
        telegramId: chatId,
        nombre: frecuente.nombre,
        calorias: frecuente.calorias,
        proteinas: frecuente.proteinas,
        carbohidratos: frecuente.carbohidratos,
        grasas: frecuente.grasas,
        cantidad: frecuente.cantidad
      });
      
      const stats = await getTodayStats(chatId);
      const user = await User.findOne({ telegramId: chatId });
      const meta = getMetaDelDia(user);
      const restantes = meta - stats.caloriasNetas;
      
      await bot.answerCallbackQuery(query.id, { text: '✅ Registrado!' });
      await bot.sendMessage(chatId, `✅ Registrado: ${frecuente.nombre} (${frecuente.calorias} kcal)\n\n${restantes > 0 ? `🎯 Te quedan: ${restantes} kcal` : `⚠️ Excedido por: ${Math.abs(restantes)} kcal`}`);
    }
    return;
  }

  if (data.startsWith('delfav_')) {
    const id = data.replace('delfav_', '');
    const deleted = await FrequentMeal.findByIdAndDelete(id);
    
    if (deleted) {
      await bot.answerCallbackQuery(query.id, { text: '🗑️ Eliminado!' });
      await bot.sendMessage(chatId, `🗑️ Eliminado: ${deleted.nombre}`);
    }
  }

  if (data === 'confirm_food') {
    const state = userStates[chatId];
    if (state && state.pendingFood) {
      await Food.create({
        telegramId: chatId,
        ...state.pendingFood
      });
      
      const stats = await getTodayStats(chatId);
      const user = await User.findOne({ telegramId: chatId });
      const meta = getMetaDelDia(user);
      const restantes = meta - stats.caloriasNetas;
      
      await bot.answerCallbackQuery(query.id, { text: '✅ Guardado!' });
      await bot.sendMessage(chatId, `✅ Registrado: ${state.pendingFood.nombre} (${state.pendingFood.calorias} kcal)\n\n${restantes > 0 ? `🎯 Te quedan: ${restantes} kcal` : `⚠️ Excedido por: ${Math.abs(restantes)} kcal`}`);
      delete userStates[chatId];
    }
  }

  if (data === 'cancel_food') {
    await bot.answerCallbackQuery(query.id, { text: '❌ Cancelado' });
    await bot.sendMessage(chatId, '❌ Registro cancelado.');
    delete userStates[chatId];
  }
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || '';

  await bot.sendMessage(chatId, '🔍 Analizando imagen...');

  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await fetch(fileUrl);
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    const resultado = await analyzeImageWithGemini(imageBuffer, caption);

    if (resultado) {
      userStates[chatId] = { pendingFood: resultado };

      await bot.sendMessage(chatId, `📸 *Análisis de imagen:*

🍽️ ${resultado.nombre}
🔥 Calorías: ${resultado.calorias} kcal
🥩 Proteínas: ${resultado.proteinas}g
🍞 Carbohidratos: ${resultado.carbohidratos}g
🧈 Grasas: ${resultado.grasas}g
📏 Porción: ${resultado.cantidad}

¿Guardar este registro?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Guardar', callback_data: 'confirm_food' },
              { text: '❌ Cancelar', callback_data: 'cancel_food' }
            ]
          ]
        }
      });
    } else {
      await bot.sendMessage(chatId, '❌ No pude analizar la imagen. Intenta con otra foto o describe la comida.');
    }
  } catch (error) {
    console.error('Error procesando imagen:', error);
    await bot.sendMessage(chatId, '❌ Error al procesar la imagen.');
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/') || msg.photo) return;

  const state = userStates[chatId];

  if (state) {
    switch (state.step) {
      case 'config_peso':
        const peso = parseFloat(text);
        if (!isNaN(peso)) {
          state.peso = peso;
          state.step = 'config_altura';
          await bot.sendMessage(chatId, '📏 ¿Cuál es tu altura en cm?');
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'config_altura':
        const altura = parseFloat(text);
        if (!isNaN(altura)) {
          state.altura = altura;
          state.step = 'config_edad';
          await bot.sendMessage(chatId, '🎂 ¿Cuál es tu edad?');
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'config_edad':
        const edad = parseInt(text);
        if (!isNaN(edad)) {
          state.edad = edad;
          state.step = 'config_sexo';
          await bot.sendMessage(chatId, '👤 ¿Cuál es tu sexo?', {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '👨 Masculino', callback_data: 'sexo_m' },
                  { text: '👩 Femenino', callback_data: 'sexo_f' }
                ]
              ]
            }
          });
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'config_peso_meta':
        const pesoMeta = parseFloat(text);
        if (!isNaN(pesoMeta) && pesoMeta > 0) {
          state.pesoMeta = pesoMeta;

          // Calcular TMB y TDEE para mostrar botones dinámicos
          let tmbTemp;
          if (state.sexo === 'masculino') {
            tmbTemp = 88.362 + (13.397 * state.peso) + (4.799 * state.altura) - (5.677 * state.edad);
          } else {
            tmbTemp = 447.593 + (9.247 * state.peso) + (3.098 * state.altura) - (4.330 * state.edad);
          }
          const tdeeTemp = Math.round(tmbTemp * state.factorActividad);
          const minKcal = state.sexo === 'masculino' ? 1500 : 1200;

          if (state.objetivo === 'deficit') {
            state.step = 'config_nivel_deficit';
            const kgPerder = state.peso - pesoMeta;
            const opciones = [
              { deficit: 250, nombre: 'Leve', emoji: '🟢' },
              { deficit: 500, nombre: 'Moderado', emoji: '🟡' },
              { deficit: 750, nombre: 'Agresivo', emoji: '🟠' },
              { deficit: 1000, nombre: 'Extremo', emoji: '🔴' }
            ];

            const keyboard = opciones
              .filter(o => tdeeTemp - o.deficit > 0)
              .map(o => {
                const kcalDia = tdeeTemp - o.deficit;
                const semanas = Math.round(kgPerder / (o.deficit * 7 / 7700));
                const warn = kcalDia < minKcal ? ' ⚠️' : '';
                return [{ text: `${o.emoji} ${o.nombre}: ${kcalDia} kcal/día → ~${semanas} sem${warn}`, callback_data: `deficit_${o.deficit}` }];
              });

          await bot.sendMessage(chatId, `📉 *Elige tu nivel de déficit:*\n\n_TDEE actual: ${tdeeTemp} kcal | Perder: ${kgPerder.toFixed(1)} kg_`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: keyboard }
            });
          } else if (state.objetivo === 'superavit') {
            state.step = 'config_nivel_superavit';
            const kgGanar = pesoMeta - state.peso;
            const opciones = [
              { superavit: 250, nombre: 'Lean bulk', emoji: '🟢' },
              { superavit: 400, nombre: 'Moderado', emoji: '🟡' },
              { superavit: 600, nombre: 'Agresivo', emoji: '🟠' }
            ];

            const keyboard = opciones.map(o => {
              const kcalDia = tdeeTemp + o.superavit;
              const semanas = Math.round(kgGanar / (o.superavit * 7 / 7700));
              return [{ text: `${o.emoji} ${o.nombre}: ${kcalDia} kcal/día → ~${semanas} sem`, callback_data: `superavit_${o.superavit}` }];
            });

          await bot.sendMessage(chatId, `📈 *Elige tu nivel de superávit:*\n\n_TDEE actual: ${tdeeTemp} kcal | Ganar: ${kgGanar.toFixed(1)} kg_`, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: keyboard }
            });
          }
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un peso válido en kg.');
        }
        return;

      case 'metas_calorias':
        const metaCal = parseInt(text);
        if (!isNaN(metaCal)) {
          state.metaCalorias = metaCal;
          state.step = 'metas_proteinas';
          await bot.sendMessage(chatId, '🥩 ¿Cuántos gramos de proteína al día?');
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'metas_proteinas':
        const metaProt = parseInt(text);
        if (!isNaN(metaProt)) {
          state.metaProteinas = metaProt;
          state.step = 'metas_carbohidratos';
          await bot.sendMessage(chatId, '🍞 ¿Cuántos gramos de carbohidratos al día?');
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'metas_carbohidratos':
        const metaCarb = parseInt(text);
        if (!isNaN(metaCarb)) {
          state.metaCarbohidratos = metaCarb;
          state.step = 'metas_grasas';
          await bot.sendMessage(chatId, '🧈 ¿Cuántos gramos de grasas al día?');
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'metas_grasas':
        const metaGrasa = parseInt(text);
        if (!isNaN(metaGrasa)) {
          await User.findOneAndUpdate(
            { telegramId: chatId },
            {
              metaCalorias: state.metaCalorias,
              metaProteinas: state.metaProteinas,
              metaCarbohidratos: state.metaCarbohidratos,
              metaGrasas: metaGrasa
            },
            { upsert: true }
          );
          delete userStates[chatId];
          await bot.sendMessage(chatId, `✅ Metas configuradas:
🔥 Calorías: ${state.metaCalorias} kcal
🥩 Proteínas: ${state.metaProteinas}g
🍞 Carbohidratos: ${state.metaCarbohidratos}g
🧈 Grasas: ${metaGrasa}g`);
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'peso':
        const pesoReg = parseFloat(text);
        if (!isNaN(pesoReg)) {
          await Weight.create({ telegramId: chatId, peso: pesoReg });
          await User.findOneAndUpdate({ telegramId: chatId }, { peso: pesoReg }, { upsert: true });
          delete userStates[chatId];
          await bot.sendMessage(chatId, `✅ Peso registrado: ${pesoReg} kg`);
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'ejercicio_nombre':
        state.ejercicioNombre = text;
        state.step = 'ejercicio_calorias';
        await bot.sendMessage(chatId, `🔥 ¿Cuántas calorías quemaste con "${text}"?`);
        return;

      case 'ejercicio_calorias':
        const calQuemadas = parseInt(text);
        if (!isNaN(calQuemadas)) {
          await Exercise.create({
            telegramId: chatId,
            nombre: state.ejercicioNombre,
            caloriasQuemadas: calQuemadas
          });
          delete userStates[chatId];
          await bot.sendMessage(chatId, `✅ Ejercicio registrado:
🏃 ${state.ejercicioNombre}: -${calQuemadas} kcal`);
        } else {
          await bot.sendMessage(chatId, '❌ Por favor ingresa un número válido.');
        }
        return;

      case 'consultar':
        delete userStates[chatId];
        await bot.sendMessage(chatId, '🔍 Analizando...');
        const consultaResult = await consultWithGemini(text);
        if (consultaResult) {
          await bot.sendMessage(chatId, `📊 *Información nutricional de "${consultaResult.nombre}":*

🔥 Calorías: ${consultaResult.calorias} kcal
🥩 Proteínas: ${consultaResult.proteinas}g
🍞 Carbohidratos: ${consultaResult.carbohidratos}g
🧈 Grasas: ${consultaResult.grasas}g
📏 Porción: ${consultaResult.cantidad}

_Este es solo una consulta, no se ha registrado._`, { parse_mode: 'Markdown' });
        } else {
          await bot.sendMessage(chatId, '❌ No pude analizar esa comida.');
        }
        return;
    }
  }

  await bot.sendMessage(chatId, '🔍 Analizando...');
  const resultado = await analyzeTextWithGemini(text);

  if (resultado) {
    userStates[chatId] = { pendingFood: resultado };

    await bot.sendMessage(chatId, `📝 *Análisis:*

🍽️ ${resultado.nombre}
🔥 Calorías: ${resultado.calorias} kcal
🥩 Proteínas: ${resultado.proteinas}g
🍞 Carbohidratos: ${resultado.carbohidratos}g
🧈 Grasas: ${resultado.grasas}g
📏 Porción: ${resultado.cantidad}

¿Guardar este registro?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Guardar', callback_data: 'confirm_food' },
            { text: '❌ Cancelar', callback_data: 'cancel_food' }
          ]
        ]
      }
    });
  } else {
    await bot.sendMessage(chatId, '❌ No pude analizar esa comida. Intenta ser más específico o envía una foto.');
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // --- SEXO → pasa a ACTIVIDAD ---
  if (data === 'sexo_m' || data === 'sexo_f') {
    const state = userStates[chatId];
    if (state && state.step === 'config_sexo') {
      state.sexo = data === 'sexo_m' ? 'masculino' : 'femenino';
      state.step = 'config_actividad';
      
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '🏃 ¿Cuál es tu nivel de actividad física?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🪑 Sedentario (oficina, poco movimiento)', callback_data: 'act_1.2' }],
            [{ text: '🚶 Ligero (1-3 días/semana)', callback_data: 'act_1.375' }],
            [{ text: '🏃 Moderado (3-5 días/semana)', callback_data: 'act_1.55' }],
            [{ text: '💪 Intenso (6-7 días/semana)', callback_data: 'act_1.725' }],
            [{ text: '🔥 Muy intenso (atleta/trabajo físico)', callback_data: 'act_1.9' }]
          ]
        }
      });
    }
  }

  // --- ACTIVIDAD → pasa a OBJETIVO ---
  if (data.startsWith('act_')) {
    const state = userStates[chatId];
    if (state && state.step === 'config_actividad') {
      const factorActividad = parseFloat(data.replace('act_', ''));
      state.factorActividad = factorActividad;

      const actividadNombres = {
        1.2: 'Sedentario',
        1.375: 'Ligero',
        1.55: 'Moderado',
        1.725: 'Intenso',
        1.9: 'Muy intenso'
      };
      state.actividadNombre = actividadNombres[factorActividad] || 'Moderado';
      state.step = 'config_objetivo';

      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '🎯 ¿Cuál es tu objetivo?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📉 Perder peso', callback_data: 'obj_deficit' }],
            [{ text: '⚖️ Mantener peso', callback_data: 'obj_mantener' }],
            [{ text: '📈 Ganar masa', callback_data: 'obj_superavit' }]
          ]
        }
      });
    }
  }

  // --- OBJETIVO → pasa a PESO META o PLAN FINDE ---
  if (data.startsWith('obj_')) {
    const state = userStates[chatId];
    if (state && state.step === 'config_objetivo') {
      state.objetivo = data.replace('obj_', '');

      await bot.answerCallbackQuery(query.id);

      if (state.objetivo === 'mantener') {
        state.step = 'config_plan_finde';
        await bot.sendMessage(chatId, '📅 ¿Quieres un plan de fin de semana?\n\n_Redistribuye calorías: comes un poco menos de L-V y un poco más los S-D, manteniendo el mismo total semanal._', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Sí, plan de finde', callback_data: 'finde_si' }],
              [{ text: '❌ No, igual todos los días', callback_data: 'finde_no' }]
            ]
          }
        });
      } else {
        state.step = 'config_peso_meta';
        await bot.sendMessage(chatId, '🎯 ¿Cuál es tu peso objetivo en kg?');
      }
    }
  }

  // --- NIVEL DEFICIT → pasa a PLAN FINDE ---
  if (data.startsWith('deficit_')) {
    const state = userStates[chatId];
    if (state && state.step === 'config_nivel_deficit') {
      const deficitKcal = parseInt(data.replace('deficit_', ''));
      state.deficitKcal = deficitKcal;

      const nivelNombres = { 250: 'leve', 500: 'moderado', 750: 'agresivo', 1000: 'extremo' };
      state.nivelDeficit = nivelNombres[deficitKcal] || 'moderado';

      state.step = 'config_plan_finde';
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '📅 ¿Quieres un plan de fin de semana?\n\n_Redistribuye calorías: comes un poco menos de L-V y un poco más los S-D, manteniendo el mismo total semanal._', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Sí, plan de finde', callback_data: 'finde_si' }],
            [{ text: '❌ No, igual todos los días', callback_data: 'finde_no' }]
          ]
        }
      });
    }
  }

  // --- NIVEL SUPERAVIT → pasa a PLAN FINDE ---
  if (data.startsWith('superavit_')) {
    const state = userStates[chatId];
    if (state && state.step === 'config_nivel_superavit') {
      const superavitKcal = parseInt(data.replace('superavit_', ''));
      state.superavitKcal = superavitKcal;

      const nivelNombres = { 250: 'lean bulk', 400: 'moderado', 600: 'agresivo' };
      state.nivelSuperavit = nivelNombres[superavitKcal] || 'moderado';

      state.step = 'config_plan_finde';
      await bot.answerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '📅 ¿Quieres un plan de fin de semana?\n\n_Redistribuye calorías: comes un poco menos de L-V y un poco más los S-D, manteniendo el mismo total semanal._', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Sí, plan de finde', callback_data: 'finde_si' }],
            [{ text: '❌ No, igual todos los días', callback_data: 'finde_no' }]
          ]
        }
      });
    }
  }

  // --- PLAN FINDE → GUARDAR Y MOSTRAR RESULTADO ---
  if (data === 'finde_si' || data === 'finde_no') {
    const state = userStates[chatId];
    if (state && state.step === 'config_plan_finde') {
      state.planFinde = data === 'finde_si';

      // Calcular TMB
      let tmb;
      if (state.sexo === 'masculino') {
        tmb = 88.362 + (13.397 * state.peso) + (4.799 * state.altura) - (5.677 * state.edad);
      } else {
        tmb = 447.593 + (9.247 * state.peso) + (3.098 * state.altura) - (4.330 * state.edad);
      }

      // Calcular TDEE
      const tdee = Math.round(tmb * state.factorActividad);

      // Calcular meta diaria
      let metaDiaria;
      if (state.objetivo === 'deficit') {
        metaDiaria = tdee - (state.deficitKcal || 500);
      } else if (state.objetivo === 'superavit') {
        metaDiaria = tdee + (state.superavitKcal || 250);
      } else {
        metaDiaria = tdee;
      }

      // Calcular plan semanal
      let metaLV, metaFinde;
      if (state.planFinde) {
        const metaSemanal = metaDiaria * 7;
        metaLV = Math.round(metaSemanal * 0.135);
        metaFinde = Math.round(metaSemanal * 0.1625);
      } else {
        metaLV = metaDiaria;
        metaFinde = metaDiaria;
      }

      // Calcular semanas estimadas
      let semanasTexto = '';
      if (state.objetivo === 'deficit' && state.pesoMeta) {
        const kgPerder = state.peso - state.pesoMeta;
        const kgPorSemana = (state.deficitKcal * 7) / 7700;
        const semanas = Math.round(kgPerder / kgPorSemana);
        semanasTexto = `\n⏱️ Tiempo estimado: ~${semanas} semanas`;
      } else if (state.objetivo === 'superavit' && state.pesoMeta) {
        const kgGanar = state.pesoMeta - state.peso;
        const kgPorSemana = (state.superavitKcal * 7) / 7700;
        const semanas = Math.round(kgGanar / kgPorSemana);
        semanasTexto = `\n⏱️ Tiempo estimado: ~${semanas} semanas`;
      }

      // Calcular macros según objetivo
      let pctProt, pctCarb, pctGrasa;
      if (state.objetivo === 'deficit') {
        pctProt = 0.40; pctCarb = 0.35; pctGrasa = 0.25;
      } else if (state.objetivo === 'superavit') {
        pctProt = 0.30; pctCarb = 0.45; pctGrasa = 0.25;
      } else {
        pctProt = 0.30; pctCarb = 0.40; pctGrasa = 0.30;
      }
      const metaProteinas = Math.round((metaDiaria * pctProt) / 4);
      const metaCarbohidratos = Math.round((metaDiaria * pctCarb) / 4);
      const metaGrasas = Math.round((metaDiaria * pctGrasa) / 9);

      // Guardar en DB
      const objetivoNombres = { deficit: 'Perder peso', mantener: 'Mantener peso', superavit: 'Ganar masa' };
      await User.findOneAndUpdate(
        { telegramId: chatId },
        {
          peso: state.peso,
          altura: state.altura,
          edad: state.edad,
          sexo: state.sexo,
          actividad: state.actividadNombre,
          objetivo: state.objetivo,
          pesoMeta: state.pesoMeta || null,
          nivelDeficit: state.nivelDeficit || null,
          planFinde: state.planFinde,
          metaCalorias: metaDiaria,
          metaCaloriasLV: metaLV,
          metaCaloriasFinde: metaFinde,
          metaProteinas,
          metaCarbohidratos,
          metaGrasas
        },
        { upsert: true }
      );

      delete userStates[chatId];
      bot.answerCallbackQuery(query.id);

      // Construir mensaje
      let deficitTexto = '';
      if (state.objetivo === 'deficit') {
        deficitTexto = `\n📉 Déficit: -${state.deficitKcal} kcal/día (${state.nivelDeficit})`;
      } else if (state.objetivo === 'superavit') {
        deficitTexto = `\n📈 Superávit: +${state.superavitKcal} kcal/día (${state.nivelSuperavit})`;
      }

      let pesoMetaTexto = state.pesoMeta ? ` → Meta: ${state.pesoMeta} kg` : '';

      let planTexto = '';
      if (state.planFinde) {
        planTexto = `\n\n📅 *Plan semanal:*\n  L-V: ${metaLV} kcal/día\n  S-D: ${metaFinde} kcal/día`;
      }

      bot.sendMessage(chatId, `✅ *Configuración guardada:*

⚖️ Peso: ${state.peso} kg${pesoMetaTexto}
📏 Altura: ${state.altura} cm
🎂 Edad: ${state.edad} años
👤 Sexo: ${state.sexo}
🏃 Actividad: ${state.actividadNombre}
🎯 Objetivo: ${objetivoNombres[state.objetivo]}

🔥 TMB: ${Math.round(tmb)} kcal
📊 TDEE (mantenimiento): ${tdee} kcal${deficitTexto}
🎯 Meta diaria: ${metaDiaria} kcal${semanasTexto}${planTexto}

📋 *Macros diarios:*
🥩 Proteínas: ${metaProteinas}g
🍞 Carbohidratos: ${metaCarbohidratos}g
🧈 Grasas: ${metaGrasas}g

Puedes ajustar tus metas con /metas`, { parse_mode: 'Markdown' });
    }
  }
});

console.log('🤖 Bot CalCounter iniciado...');

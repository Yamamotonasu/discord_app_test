import { GatewayIntentBits, Client, Partials, Message } from 'discord.js';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as cron from 'node-cron';

// .envファイルを読み込む
dotenv.config();

// Supabaseクライアントの初期化
const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Botで使うGatewayIntents、partials
const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Botがきちんと起動したか確認
client.once('ready', () => {
    console.log('Ready!');
    if(client.user){
        console.log(client.user.tag);
    }

    // 毎分リマインダーをチェックするcronジョブ
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const nowUTC = now.toISOString();
        const nowJST = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`[UTC: ${nowUTC}] [JST: ${nowJST}] リマインダーチェック実行中...`);
        
        // 現在時刻を過ぎた未通知のリマインダーを取得
        const { data, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('notified', false)
            .lte('scheduled_at', nowUTC);

        if (error) {
            console.error('Error fetching reminders:', error);
            return;
        }

        console.log(`取得したリマインダー数: ${data?.length || 0}`);

        if (!data || data.length === 0) {
            return;
        }

        // 各リマインダーを通知
        for (const reminder of data) {
            try {
                const scheduledJST = new Date(reminder.scheduled_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                console.log(`リマインダー処理中: ID=${reminder.id}, scheduled_at(UTC)=${reminder.scheduled_at}, scheduled_at(JST)=${scheduledJST}, channel_id=${reminder.channel_id}`);
                const channel = await client.channels.fetch(reminder.channel_id);
                
                if (!channel) {
                    console.error(`チャンネルが見つかりません: ${reminder.channel_id}`);
                    continue;
                }

                if ('send' in channel) {
                    await channel.send(`🔔 リマインダー: ${reminder.message}`);
                    console.log(`リマインダー送信成功: ID=${reminder.id}`);
                } else {
                    console.error(`チャンネルがテキストチャンネルではありません: ${reminder.channel_id}`);
                    continue;
                }

                // 通知済みフラグを更新
                const { error: updateError } = await supabase
                    .from('reminders')
                    .update({ notified: true })
                    .eq('id', reminder.id);

                if (updateError) {
                    console.error(`通知済みフラグ更新エラー: ID=${reminder.id}`, updateError);
                } else {
                    console.log(`通知済みフラグ更新成功: ID=${reminder.id}`);
                }
            } catch (error) {
                console.error(`Error sending reminder ${reminder.id}:`, error);
            }
        }
    });

    console.log('リマインダーチェックが開始されました（毎分実行）');
});

// !timeと入力すると現在時刻を返信するように
client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;
    if (message.content === '/time') {
        const date1 = new Date();
        if ('send' in message.channel) {
            message.channel.send(date1.toLocaleString());
        }
    }

    // !remindコマンド: !remind YYYY/MM/DD HH:mm メッセージ
    if (message.content.startsWith('!remind ')) {
        const args = message.content.slice(8).trim(); // "!remind "を削除
        const parts = args.split(' ');
        
        if (parts.length < 3) {
            if ('send' in message.channel) {
                message.channel.send('使用方法: `!remind YYYY/MM/DD HH:mm メッセージ`\n例: `!remind 2023/11/24 15:00 会議の時間です`');
            }
            return;
        }

        const dateStr = parts[0]; // YYYY/MM/DD
        const timeStr = parts[1]; // HH:mm
        const reminderMessage = parts.slice(2).join(' '); // 残りがメッセージ

        // 日時のパース（JSTとして解釈）
        try {
            const [year, month, day] = dateStr.split('/').map(Number);
            const [hour, minute] = timeStr.split(':').map(Number);
            
            // ユーザー入力はJST（UTC+9）として扱う
            // ローカルタイムゾーンで日時を作成（サーバーがJSTで動いている場合）
            const scheduledAtJST = new Date(year, month - 1, day, hour, minute);
            
            // JSTからUTCへの変換（9時間引く）
            // 注意: サマータイムを考慮しない簡易実装
            const scheduledAtUTC = new Date(scheduledAtJST.getTime() - 9 * 60 * 60 * 1000);

            // 過去の日時でないかチェック（JSTで比較）
            const nowJST = new Date();
            if (scheduledAtJST <= nowJST) {
                if ('send' in message.channel) {
                    message.channel.send('エラー: 過去の日時は指定できません。');
                }
                return;
            }

            // データベースに保存（UTCで保存）
            const { data, error } = await supabase
                .from('reminders')
                .insert([
                    {
                        user_id: message.author.id,
                        channel_id: message.channel.id,
                        message: reminderMessage,
                        scheduled_at: scheduledAtUTC.toISOString(),
                    },
                ])
                .select();

            if (error) {
                console.error('Error inserting reminder:', error);
                if ('send' in message.channel) {
                    message.channel.send('エラー: リマインダーの登録に失敗しました。');
                }
                return;
            }

            if ('send' in message.channel) {
                // JSTで表示
                const jstDateStr = scheduledAtJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                message.channel.send(`✅ リマインダーを登録しました！\n日時: ${jstDateStr} (JST)\n内容: ${reminderMessage}`);
            }
        } catch (error) {
            console.error('Error parsing date:', error);
            if ('send' in message.channel) {
                message.channel.send('エラー: 日時の形式が正しくありません。`YYYY/MM/DD HH:mm`の形式で入力してください。');
            }
        }
    }

    // !listコマンド: 自分のリマインダー一覧を表示
    if (message.content === '!list') {
        const { data, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('user_id', message.author.id)
            .eq('notified', false)
            .order('scheduled_at', { ascending: true });

        if (error) {
            console.error('Error fetching reminders:', error);
            if ('send' in message.channel) {
                message.channel.send('エラー: リマインダーの取得に失敗しました。');
            }
            return;
        }

        if (!data || data.length === 0) {
            if ('send' in message.channel) {
                message.channel.send('登録されているリマインダーはありません。');
            }
            return;
        }

        const reminderList = data.map((r, index) => {
            const date = new Date(r.scheduled_at);
            return `${index + 1}. ${date.toLocaleString('ja-JP')} - ${r.message}`;
        }).join('\n');

        if ('send' in message.channel) {
            message.channel.send(`📋 あなたのリマインダー一覧:\n${reminderList}`);
        }
    }
});

// ボット作成時のトークンでDiscordと接続
client.login(process.env.TOKEN);

